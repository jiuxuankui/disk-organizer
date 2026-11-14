import fs from 'node:fs';
import path from 'node:path';
import {
  VIDEO_EXTENSIONS,
  type VideoRequest,
  type VideoResult,
  type VideoState,
} from '@shared/video';
import {
  inspectVideo,
  probeVideo,
  runVideoTool,
  verifyVideoOutput,
  videoEncodeArgs,
  videoProgress,
} from './videoCore';

interface VideoServiceDeps {
  toolsDir: string;
  fixedDriveLetters: () => Set<string>;
}

export class VideoService {
  private state: VideoState = {
    status: 'idle',
    total: 0,
    processed: 0,
    currentPath: '',
    percent: 0,
    results: [],
  };
  private active: Promise<void> | null = null;
  private controller: AbortController | null = null;

  constructor(private readonly deps: VideoServiceDeps) {}

  getState(): VideoState {
    return structuredClone(this.state);
  }

  isRunning(): boolean {
    return this.active !== null;
  }

  whenIdle(): Promise<void> {
    return this.active ?? Promise.resolve();
  }

  private localPath(input: string): string {
    const validate = (value: string): void => {
      if (
        !/^[a-z]:[\\/]/i.test(value) ||
        value.slice(2).includes(':') ||
        value.includes('\0') ||
        !this.deps.fixedDriveLetters().has(value.slice(0, 2).toUpperCase())
      ) {
        throw new Error('只支持可用的本地固定硬盘路径，不支持网络、设备或流地址');
      }
    };
    validate(input);
    const resolved = fs.realpathSync(input);
    validate(resolved);
    return resolved;
  }

  start(input: VideoRequest): VideoState {
    if (this.active) throw new Error('已有视频压缩任务正在进行');
    for (const name of ['ffmpeg.exe', 'ffprobe.exe']) {
      if (!fs.existsSync(path.join(this.deps.toolsDir, name))) {
        throw new Error('本地视频工具缺失，请重新安装完整安装包');
      }
    }
    const outputDir = this.localPath(input.outputDir);
    if (!fs.statSync(outputDir).isDirectory()) throw new Error('请选择有效的输出文件夹');
    const paths = [...new Set(input.paths.map((value) => this.localPath(value)))];
    for (const source of paths) {
      const extension = path.extname(source).slice(1).toLowerCase();
      if (!VIDEO_EXTENSIONS.some((item) => item === extension) || !fs.statSync(source).isFile()) {
        throw new Error(`不是支持的视频文件：${source}`);
      }
    }
    if (paths.length === 0) throw new Error('请至少选择一个视频');
    this.controller = new AbortController();
    this.state = {
      status: 'running',
      total: paths.length,
      processed: 0,
      currentPath: '',
      percent: 0,
      results: [],
    };
    this.active = this.execute({ ...input, paths, outputDir }, this.controller.signal).finally(
      () => {
        this.active = null;
        this.controller = null;
      },
    );
    return this.getState();
  }

  cancel(): VideoState {
    if (this.controller) {
      this.state.status = 'cancelling';
      this.controller.abort();
    }
    return this.getState();
  }

  private async publish(temp: string, directory: string, name: string): Promise<string> {
    for (let index = 0; index < 10000; index += 1) {
      const suffix = index === 0 ? '' : ` (${index})`;
      const target = path.join(directory, `${name.slice(0, 160)}.compressed${suffix}.mkv`);
      try {
        await fs.promises.copyFile(temp, target, fs.constants.COPYFILE_EXCL);
        return target;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    throw new Error('输出目录同名文件过多，请选择其他目录');
  }

  private async compress(
    source: string,
    request: VideoRequest,
    signal: AbortSignal,
  ): Promise<VideoResult> {
    const result: VideoResult = {
      path: source,
      outputPath: null,
      status: 'failed',
      inputBytes: 0,
      outputBytes: 0,
      message: '',
    };
    let workDir: string | null = null;
    try {
      signal.throwIfAborted();
      this.localPath(source);
      this.localPath(request.outputDir);
      const before = await fs.promises.stat(source);
      result.inputBytes = before.size;
      const disk = await fs.promises.statfs(request.outputDir);
      if (disk.bavail * disk.bsize < before.size * 2 + 64 * 1024 * 1024) {
        throw new Error('输出硬盘可用空间不足，需要至少原文件两倍大小及 64 MB 临时空间');
      }
      const ffmpeg = path.join(this.deps.toolsDir, 'ffmpeg.exe');
      const ffprobe = path.join(this.deps.toolsDir, 'ffprobe.exe');
      const metadata = await probeVideo(ffprobe, source, signal);
      const { duration, pixelFormat } = inspectVideo(metadata);
      workDir = await fs.promises.mkdtemp(path.join(request.outputDir, '.disk-organizer-video-'));
      const temp = path.join(workDir, 'output.mkv');
      await runVideoTool(
        ffmpeg,
        videoEncodeArgs(source, temp, request.quality, pixelFormat),
        signal,
        (line) => {
          const percent = videoProgress(line, duration);
          if (percent !== null) this.state.percent = percent;
        },
      );
      const outputMetadata = await probeVideo(ffprobe, temp, signal);
      verifyVideoOutput(metadata, outputMetadata);
      const after = await fs.promises.stat(source);
      if (
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ino !== before.ino
      ) {
        throw new Error('压缩过程中原文件发生变化，请重新选择');
      }
      const output = await fs.promises.stat(temp);
      signal.throwIfAborted();
      if (output.size >= before.size) {
        result.status = 'skipped';
        result.message = '没有缩小体积，已丢弃本次生成文件并保留原文件';
      } else {
        result.outputPath = await this.publish(temp, request.outputDir, path.parse(source).name);
        result.outputBytes = output.size;
        result.status = 'completed';
        result.message = '压缩完成，原文件保留';
      }
    } catch (error) {
      result.status = signal.aborted ? 'cancelled' : 'failed';
      result.message = signal.aborted
        ? '已取消，原文件保留'
        : error instanceof Error
          ? error.message
          : String(error);
    } finally {
      if (workDir) {
        try {
          await fs.promises.rm(workDir, { recursive: true, force: true });
        } catch {
          result.message += `；临时文件未能清理：${workDir}`;
        }
      }
    }
    return result;
  }

  private async execute(request: VideoRequest, signal: AbortSignal): Promise<void> {
    for (const source of request.paths) {
      if (signal.aborted) break;
      this.state.currentPath = source;
      this.state.percent = 0;
      this.state.results.push(await this.compress(source, request, signal));
      this.state.processed += 1;
    }
    this.state.status = signal.aborted ? 'cancelled' : 'completed';
    this.state.currentPath = '';
    this.state.percent = 0;
  }
}

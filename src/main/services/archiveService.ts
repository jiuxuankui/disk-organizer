import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { finished, pipeline } from 'node:stream/promises';
import { TarArchive, ZipArchive } from 'archiver';
import type { ArchiveRequest, ArchiveState } from '@shared/archive';

interface ArchiveSource {
  path: string;
  size: number;
  mtimeMs: number;
}

type ArchiveInput = Omit<ArchiveRequest, 'fileIds'> & { sources: ArchiveSource[] };

export function archiveEntryName(source: string): string {
  if (!/^[a-z]:[\\/]/i.test(source) || /[:\0]/.test(source.slice(2))) {
    throw new Error('只支持本地硬盘文件');
  }
  const parts = source.slice(3).split(/[\\/]/);
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error('文件路径包含无效目录');
  }
  return `${source[0].toUpperCase()}/${parts.join('/')}`;
}

export class ArchiveService {
  private state: ArchiveState = {
    status: 'idle',
    total: 0,
    processed: 0,
    percent: 0,
    outputPath: null,
    outputBytes: 0,
    message: '',
  };
  private active: Promise<void> | null = null;
  private controller: AbortController | null = null;

  constructor(private readonly fixedDriveLetters: () => Set<string>) {}

  getState(): ArchiveState {
    return structuredClone(this.state);
  }
  isRunning(): boolean {
    return this.active !== null;
  }
  whenIdle(): Promise<void> {
    return this.active ?? Promise.resolve();
  }

  private localPath(value: string): string {
    if (!/^[a-z]:[\\/]/i.test(value) || /[:\0]/.test(value.slice(2))) {
      throw new Error('只支持本地硬盘路径');
    }
    if (!this.fixedDriveLetters().has(value.slice(0, 2).toUpperCase())) {
      throw new Error('只支持可用的本地固定硬盘');
    }
    const resolved = fs.realpathSync(value);
    if (resolved.length > 3) archiveEntryName(resolved);
    if (!this.fixedDriveLetters().has(resolved.slice(0, 2).toUpperCase())) {
      throw new Error('路径指向非本地固定硬盘');
    }
    return resolved;
  }

  start(input: ArchiveInput): ArchiveState {
    if (this.active) throw new Error('已有压缩打包任务正在进行');
    if (input.sources.length === 0) throw new Error('请至少选择一个文件');
    const outputDir = this.localPath(input.outputDir);
    if (!fs.statSync(outputDir).isDirectory()) throw new Error('输出位置必须是文件夹');
    this.controller = new AbortController();
    this.state = {
      status: 'running',
      total: input.sources.length,
      processed: 0,
      percent: 0,
      outputPath: null,
      outputBytes: 0,
      message: '正在打包，原文件始终保留',
    };
    this.active = this.execute({ ...input, outputDir }, this.controller.signal).finally(() => {
      this.active = null;
      this.controller = null;
    });
    return this.getState();
  }

  cancel(): ArchiveState {
    if (this.controller) {
      this.state.status = 'cancelling';
      this.controller.abort();
    }
    return this.getState();
  }

  private async execute(input: ArchiveInput, signal: AbortSignal): Promise<void> {
    let workDir: string | null = null;
    try {
      signal.throwIfAborted();
      const totalBytes = input.sources.reduce((sum, file) => sum + file.size, 0);
      const disk = await fs.promises.statfs(input.outputDir);
      if (disk.bavail * disk.bsize < totalBytes * 2 + 64 * 1024 * 1024) {
        throw new Error('输出盘空间不足，需要至少原文件总大小两倍及 64 MB 临时空间');
      }
      workDir = await fs.promises.mkdtemp(path.join(input.outputDir, '.disk-organizer-archive-'));
      const temp = path.join(workDir, `output.${input.format}`);
      await this.writeArchive(input, temp, totalBytes, signal);
      signal.throwIfAborted();
      const bytes = (await fs.promises.stat(temp)).size;
      for (let index = 0; index < 10000; index += 1) {
        const suffix = index === 0 ? '' : ` (${index})`;
        const target = path.join(input.outputDir, `${input.name}${suffix}.${input.format}`);
        try {
          await fs.promises.copyFile(temp, target, fs.constants.COPYFILE_EXCL);
          this.state.outputPath = target;
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
      }
      if (!this.state.outputPath) throw new Error('同名输出过多，请更改压缩包名称');
      this.state.outputBytes = bytes;
      this.state.percent = 100;
      this.state.status = 'completed';
      this.state.message = '打包完成，原文件保留；解压后按盘符和原目录排列';
    } catch (error) {
      this.state.status = signal.aborted ? 'cancelled' : 'failed';
      this.state.message = signal.aborted
        ? '已取消打包，原文件保留'
        : error instanceof Error
          ? error.message
          : String(error);
    } finally {
      if (workDir) {
        try {
          await fs.promises.rm(workDir, { recursive: true, force: true });
        } catch {
          this.state.message += `；临时文件未能清理：${workDir}`;
        }
      }
    }
  }

  private async writeArchive(
    input: ArchiveInput,
    target: string,
    totalBytes: number,
    signal: AbortSignal,
  ): Promise<void> {
    const archive =
      input.format === 'zip'
        ? new ZipArchive({ zlib: { level: 9 } })
        : new TarArchive({ gzip: true, gzipOptions: { level: 9 } });
    archive.on('warning', (error) => archive.destroy(error));
    const output = fs.createWriteStream(target, { flags: 'wx' });
    const writing = pipeline(archive, output, { signal }).then(
      () => null,
      (error: Error) => error,
    );
    let readBytes = 0;
    const names = new Set<string>();
    try {
      for (const file of input.sources) {
        signal.throwIfAborted();
        const source = this.localPath(file.path);
        const name = archiveEntryName(source);
        if (names.has(name.toLowerCase()))
          throw new Error('多个所选路径指向同一个文件，请取消重复选择');
        names.add(name.toLowerCase());
        const handle = await fs.promises.open(source, 'r');
        let stream: fs.ReadStream | null = null;
        try {
          const before = await handle.stat();
          if (
            !before.isFile() ||
            before.size !== file.size ||
            Math.trunc(before.mtimeMs) !== Math.trunc(file.mtimeMs)
          ) {
            throw new Error(`文件已变化，请重新扫描：${file.path}`);
          }
          if (archive.destroyed) throw (await writing) ?? new Error('压缩输出流已关闭');
          stream = handle.createReadStream({ autoClose: false, signal });
          stream.on('data', (chunk) => {
            readBytes += chunk.length;
            this.state.percent = totalBytes
              ? Math.min(99, Math.floor((readBytes / totalBytes) * 100))
              : 0;
          });
          stream.on('error', (error) => archive.destroy(error));
          const entry = once(archive, 'entry', { signal });
          archive.append(stream, { name, date: before.mtime, stats: before });
          await entry;
          const after = await fs.promises.stat(source);
          if (
            after.size !== before.size ||
            after.mtimeMs !== before.mtimeMs ||
            after.ino !== before.ino
          ) {
            throw new Error(`打包时文件发生变化：${file.path}`);
          }
          this.state.processed += 1;
        } finally {
          if (stream) {
            stream.destroy();
            await finished(stream).catch(() => undefined);
          }
          await handle.close();
        }
      }
      await archive.finalize();
      const error = await writing;
      if (error) throw error;
    } catch (error) {
      archive.abort();
      archive.destroy();
      output.destroy();
      await writing;
      throw error;
    }
  }
}

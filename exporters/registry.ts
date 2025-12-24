import type { SpanExporter } from "./base.js"

export class ExporterRegistry {
  private exporters: Map<string, SpanExporter> = new Map()

  register(exporter: SpanExporter): void {
    this.exporters.set(exporter.name, exporter)
  }

  get(name: string): SpanExporter | undefined {
    return this.exporters.get(name)
  }

  list(): string[] {
    return Array.from(this.exporters.keys())
  }

  clear(): void {
    this.exporters.clear()
  }

  async shutdownAll(): Promise<void> {
    const shutdownPromises = Array.from(this.exporters.values()).map((e) =>
      e.shutdown(),
    )
    await Promise.all(shutdownPromises)
  }
}

export const registry = new ExporterRegistry()

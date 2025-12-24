import type { SpanExporter } from "./base.js"
import { OtlpGrpcExporter } from "./otlp/grpc.js"
import { ConsoleExporter } from "./console/logger.js"
import { FileJsonExporter } from "./file/json.js"
import { FileNdjsonExporter } from "./file/ndjson.js"

export interface ExporterConfig {
  format: "otlp-grpc" | "console" | "file-json" | "file-ndjson"
  otlp?: {
    url: string
    compression?: "gzip" | "none"
    headers?: Record<string, string>
  }
  console?: {
    prettyPrint?: boolean
    includeAttributes?: boolean
    includeEvents?: boolean
    colorize?: boolean
  }
  file?: {
    filepath: string
    append?: boolean
  }
  batching?: {
    enabled?: boolean
    maxBatchSize?: number
    scheduleDelay?: number
    exportTimeoutMillis?: number
    maxQueueSize?: number
  }
}

export async function loadExporter(
  config: ExporterConfig,
): Promise<SpanExporter> {
  switch (config.format) {
    case "otlp-grpc":
      if (!config.otlp?.url) {
        throw new Error("otlp.url is required for otlp-grpc format")
      }
      return new OtlpGrpcExporter({
        url: config.otlp.url,
        compression: config.otlp.compression ?? "gzip",
        headers: config.otlp.headers,
      })

    case "console":
      return new ConsoleExporter({
        prettyPrint: config.console?.prettyPrint,
        includeAttributes: config.console?.includeAttributes,
        includeEvents: config.console?.includeEvents,
        colorize: config.console?.colorize,
      })

    case "file-json":
      if (!config.file?.filepath) {
        throw new Error("file.filepath is required for file-json format")
      }
      return new FileJsonExporter({
        filepath: config.file.filepath,
        append: config.file.append ?? true,
      })

    case "file-ndjson":
      if (!config.file?.filepath) {
        throw new Error("file.filepath is required for file-ndjson format")
      }
      return new FileNdjsonExporter({
        filepath: config.file.filepath,
        append: config.file.append ?? true,
      })

    default:
      throw new Error(`Unknown exporter format: ${config.format}`)
  }
}

export function loadConfigFromEnv(): ExporterConfig {
  const format =
    (process.env.OPENTELEMETRY_EXPORT_FORMAT as ExporterConfig["format"]) ||
    "otlp-grpc"

  const config: ExporterConfig = { format }

  if (format === "otlp-grpc") {
    config.otlp = {
      url: process.env.OPENTELEMETRY_COLLECTOR_URL || "http://localhost:4317",
      compression:
        (process.env.OPENTELEMETRY_OTLP_COMPRESSION as "gzip" | "none") ||
        "gzip",
    }
  }

  if (format === "console") {
    config.console = {
      prettyPrint: process.env.OPENTELEMETRY_CONSOLE_PRETTY !== "false",
      includeAttributes:
        process.env.OPENTELEMETRY_CONSOLE_ATTRIBUTES !== "false",
      includeEvents: process.env.OPENTELEMETRY_CONSOLE_EVENTS !== "false",
    }
  }

  if (format === "file-json" || format === "file-ndjson") {
    config.file = {
      filepath: process.env.OPENTELEMETRY_FILE_PATH || "./spans.json",
      append: process.env.OPENTELEMETRY_FILE_APPEND !== "false",
    }
  }

  if (process.env.OPENTELEMETRY_BATCH_ENABLED !== "false") {
    config.batching = {
      maxBatchSize: parseInt(
        process.env.OPENTELEMETRY_BATCH_MAX_SIZE || "512",
        10,
      ),
      scheduleDelay: parseInt(
        process.env.OPENTELEMETRY_BATCH_DELAY || "5000",
        10,
      ),
      exportTimeoutMillis: parseInt(
        process.env.OPENTELEMETRY_EXPORT_TIMEOUT || "30000",
        10,
      ),
      maxQueueSize: parseInt(
        process.env.OPENTELEMETRY_BATCH_QUEUE_SIZE || "2048",
        10,
      ),
    }
  }

  return config
}

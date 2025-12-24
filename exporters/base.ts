import { ReadableSpan } from "@opentelemetry/sdk-trace-base"
import { ExportResult } from "@opentelemetry/otlp-exporter-base"

export interface SpanExporter {
  name: string
  supportsBatching: boolean
  initialize(config: unknown): Promise<void>
  export(spans: ReadableSpan[]): Promise<ExportResult>
  shutdown(): Promise<void>
  forceFlush(): Promise<void>
}

export interface NormalizedSpan {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  kind: string
  startTime: number
  endTime: number
  duration: number
  status: { code: number; message?: string }
  attributes: Record<string, unknown>
  events: { time: number; name: string; attributes: Record<string, unknown> }[]
  links: { context: string; attributes: Record<string, unknown> }[]
}

export function normalizeSpan(span: ReadableSpan): NormalizedSpan {
  const context = span.spanContext()
  return {
    traceId: context.traceId,
    spanId: context.spanId,
    parentSpanId: span.parentSpanId,
    name: span.name,
    kind: span.kind.toString(),
    startTime: span.startTime[0],
    endTime: span.endTime[0],
    duration: span.duration[0],
    status: {
      code: span.status.code,
      message: span.status.message,
    },
    attributes: { ...span.attributes },
    events: span.events.map((e) => ({
      time: e.time[0],
      name: e.name,
      attributes: { ...e.attributes },
    })),
    links: span.links.map((l) => ({
      context: l.context.traceId + ":" + l.context.spanId,
      attributes: { ...l.attributes },
    })),
  }
}

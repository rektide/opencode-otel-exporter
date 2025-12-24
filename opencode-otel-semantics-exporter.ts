import type { Plugin } from "@opencode-ai/plugin"
import { trace, context, SpanStatusCode, SpanKind } from "@opentelemetry/api"
import { NodeTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-node"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc"
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions"

const SERVICE_NAME = "opencode-otel-exporter"
const SERVICE_VERSION = "1.0.0"

let tracer: trace.Tracer | null = null

interface SpanContext {
  sessionId?: string
  messageId?: string
  toolName?: string
  fileName?: string
  userId?: string
  projectId?: string
}

function getCommonAttributes(ctx: SpanContext): Record<string, string | number | boolean> {
  const attributes: Record<string, string | number | boolean> = {
    [ATTR_SERVICE_NAME]: SERVICE_NAME,
    [ATTR_SERVICE_VERSION]: SERVICE_VERSION,
  }

  if (ctx.sessionId) {
    attributes["opencode.session.id"] = ctx.sessionId
  }
  if (ctx.messageId) {
    attributes["opencode.message.id"] = ctx.messageId
  }
  if (ctx.toolName) {
    attributes["opencode.tool.name"] = ctx.toolName
  }
  if (ctx.fileName) {
    attributes["opencode.file.name"] = ctx.fileName
  }
  if (ctx.userId) {
    attributes["opencode.user.id"] = ctx.userId
  }
  if (ctx.projectId) {
    attributes["opencode.project.id"] = ctx.projectId
  }

  return attributes
}

function getSpanContext(event: any): SpanContext {
  const ctx: SpanContext = {}
  
  if (event.type === "session.created" || event.type === "session.updated") {
    ctx.sessionId = event.properties.info?.id
    ctx.projectId = event.properties.info?.projectId
  }
  
  if (event.type === "message.updated") {
    ctx.sessionId = event.properties.info?.sessionId
    ctx.messageId = event.properties.info?.id
  }
  
  if (event.type === "tool.execute" || event.type === "tool.execute.before" || event.type === "tool.execute.after") {
    ctx.sessionId = event.properties.info?.sessionId
    ctx.toolName = event.properties.name
  }
  
  if (event.type === "tool.result") {
    ctx.sessionId = event.properties.info?.sessionId
    ctx.toolName = event.properties.name
  }
  
  if (event.type === "file.edited") {
    ctx.sessionId = event.properties.info?.sessionId
    ctx.fileName = event.properties.file
  }
  
  if (event.type === "file.watcher.updated") {
    ctx.sessionId = event.properties.info?.sessionId
    ctx.fileName = event.properties.file
  }
  
  if (event.type === "command.executed") {
    ctx.sessionId = event.properties.info?.sessionId
    ctx.toolName = "command"
  }
  
  return ctx
}

export const OtelSemanticsExporterPlugin: Plugin = async ({ project, client, $, directory, worktree }) => {
  const collectorUrl = process.env.OPENTELEMETRY_COLLECTOR_URL || "http://localhost:4317"
  
  console.log(`[otel-exporter] Initializing OpenTelemetry exporter to ${collectorUrl}`)
  
  const exporter = new OTLPTraceExporter({
    url: collectorUrl,
  })
  
  const provider = new NodeTracerProvider({
    spanProcessors: [
      new SimpleSpanProcessor(exporter),
    ],
  })
  
  provider.register()
  tracer = trace.getTracer("opencode")
  
  return {
    event: async ({ event }) => {
      try {
        const ctx = getSpanContext(event)
        
        switch (event.type) {
          case "tool.execute.before": {
            const span = tracer.startSpan("tool.execute.before", {
              kind: SpanKind.INTERNAL,
              attributes: getCommonAttributes(ctx),
            })
            span.setAttribute("tool.name", event.properties.name)
            span.setAttribute("tool.input", JSON.stringify(event.properties.input))
            span.end()
            break
          }
          
          case "tool.execute": {
            const span = tracer.startSpan("tool.execute", {
              kind: SpanKind.INTERNAL,
              attributes: getCommonAttributes(ctx),
            })
            span.setAttribute("tool.name", event.properties.name)
            span.setAttribute("tool.input", JSON.stringify(event.properties.input))
            span.setStatus({
              code: SpanStatusCode.OK,
            })
            span.end()
            break
          }
          
          case "tool.result": {
            const span = tracer.startSpan("tool.result", {
              kind: SpanKind.INTERNAL,
              attributes: getCommonAttributes(ctx),
            })
            span.setAttribute("tool.name", event.properties.name)
            span.setAttribute("tool.output", JSON.stringify(event.properties.output))
            span.setStatus({
              code: SpanStatusCode.OK,
            })
            span.end()
            break
          }
          
          case "tool.execute.after": {
            const span = tracer.startSpan("tool.execute.after", {
              kind: SpanKind.INTERNAL,
              attributes: getCommonAttributes(ctx),
            })
            span.setAttribute("tool.name", event.properties.name)
            span.end()
            break
          }
          
          case "session.created": {
            const span = tracer.startSpan("session.created", {
              kind: SpanKind.SERVER,
              attributes: getCommonAttributes(ctx),
            })
            span.setAttribute("session.status", event.properties.info?.status)
            span.setAttribute("session.name", event.properties.info?.name)
            span.end()
            break
          }
          
          case "session.updated": {
            const span = tracer.startSpan("session.updated", {
              kind: SpanKind.INTERNAL,
              attributes: getCommonAttributes(ctx),
            })
            const info = event.properties.info
            span.setAttribute("session.status", info?.status)
            span.setAttribute("session.cost", info?.cost?.toString() || "0")
            span.setAttribute("session.messageCount", info?.messageCount?.toString() || "0")
            span.end()
            break
          }
          
          case "session.idle": {
            const span = tracer.startSpan("session.idle", {
              kind: SpanKind.SERVER,
              attributes: getCommonAttributes(ctx),
            })
            span.setAttribute("session.idle", "true")
            span.end()
            break
          }
          
          case "session.completed":
          case "session.error": {
            const span = tracer.startSpan(`session.${event.type}`, {
              kind: SpanKind.SERVER,
              attributes: getCommonAttributes(ctx),
            })
            span.setAttribute("session.status", event.type)
            span.end()
            break
          }
          
          case "message.updated": {
            const span = tracer.startSpan("message.updated", {
              kind: SpanKind.PRODUCER,
              attributes: getCommonAttributes(ctx),
            })
            const part = event.properties.part
            if (part?.type === "text") {
              span.setAttribute("message.length", part.text?.length?.toString() || "0")
            } else if (part?.type === "tool") {
              span.setAttribute("message.part.type", part.type)
            } else if (part?.type === "file") {
              span.setAttribute("message.part.fileName", part.filename)
            } else if (part?.type === "snapshot") {
              span.setAttribute("message.part.type", "snapshot")
            }
            span.end()
            break
          }
          
          case "message.part.removed":
          case "message.part.updated": {
            const span = tracer.startSpan(event.type, {
              kind: SpanKind.PRODUCER,
              attributes: getCommonAttributes(ctx),
            })
            const part = event.properties.part
            if (part?.type === "text") {
              span.setAttribute("message.text.length", part.text?.length?.toString() || "0")
            }
            span.end()
            break
          }
          
          case "file.edited":
          case "file.watcher.updated": {
            const span = tracer.startSpan("file.edited", {
              kind: SpanKind.PRODUCER,
              attributes: getCommonAttributes(ctx),
            })
            span.setAttribute("file", event.properties.file)
            span.end()
            break
          }
          
          case "command.executed": {
            const span = tracer.startSpan("command.executed", {
              kind: SpanKind.CLIENT,
              attributes: getCommonAttributes(ctx),
            })
            span.setAttribute("command", event.properties.command)
            span.end()
            break
          }
          
          default:
            break
        }
      } catch (error) {
        console.error("[otel-exporter] Error processing event:", error)
      }
    },
    
    async dispose() {
      if (tracer) {
        try {
          await provider.shutdown()
          console.log("[otel-exporter] OpenTelemetry provider shut down")
        } catch (error) {
          console.error("[otel-exporter] Error shutting down provider:", error)
        }
      }
    },
  }
}

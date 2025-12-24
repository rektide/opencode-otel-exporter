import type { Plugin } from "@opencode-ai/plugin"
import { context, trace, SpanStatusCode, SpanKind } from "@opentelemetry/api"
import type { Span, Tracer } from "@opentelemetry/api"
import { Resource } from "@opentelemetry/resources"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions"
import { loadExporter, loadConfigFromEnv, SpanForwarder } from "./exporters/index.js"

const SERVICE_NAME = "opencode-otel-exporter"
const SERVICE_VERSION = "1.0.0"
const MCP_PROTOCOL_VERSION = "2025-06-18"

let tracer: Tracer | null = null
let provider: NodeTracerProvider | null = null
let exporter: Awaited<ReturnType<typeof loadExporter>> | null = null

interface SessionTraceState {
  chatSpan: Span | null
  activeToolSpans: Map<string, Span>
  pendingUserMessage?: string
}

const sessionStates = new Map<string, SessionTraceState>()

function toJson(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined
  }

  try {
    return JSON.stringify(value)
  } catch {
    return undefined
  }
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value)
  }

  return undefined
}

function extractSessionId(event: any): string | undefined {
  return (
    event?.properties?.info?.sessionId ??
    event?.properties?.info?.id ??
    event?.properties?.sessionId
  )
}

function extractRole(event: any): string | undefined {
  return (
    event?.properties?.part?.role ??
    event?.properties?.role ??
    event?.properties?.info?.role ??
    event?.properties?.info?.message?.role
  )
}

function extractTextContent(part: any): string | undefined {
  return asString(part?.text) ?? asString(part?.content) ?? asString(part?.value)
}

function getSessionState(sessionId: string): SessionTraceState {
  let state = sessionStates.get(sessionId)

  if (!state) {
    state = {
      chatSpan: null,
      activeToolSpans: new Map(),
    }
    sessionStates.set(sessionId, state)
  }

  return state
}

function getBaseAttributes(
  sessionId: string,
  event: any,
): Record<string, string> {
  const attributes: Record<string, string> = {
    "gen_ai.conversation.id": sessionId,
    "jsonrpc.protocol.version": "2.0",
    "network.transport": "tcp",
    "mcp.protocol.version": MCP_PROTOCOL_VERSION,
  }

  const projectId = asString(event?.properties?.info?.projectId)
  if (projectId) {
    attributes["opencode.project.id"] = projectId
  }

  const agentName = asString(event?.properties?.info?.agent)
  if (agentName) {
    attributes["gen_ai.system.agent_name"] = agentName
  }

  const modelName = asString(event?.properties?.info?.model)
  if (modelName) {
    attributes["gen_ai.model.name"] = modelName
  }

  return attributes
}

function ensureChatSpan(sessionId: string, event: any): Span {
  const state = getSessionState(sessionId)
  if (state.chatSpan) {
    return state.chatSpan
  }

  const span = tracer!.startSpan("chat", {
    kind: SpanKind.CLIENT,
    attributes: getBaseAttributes(sessionId, event),
  })

  if (state.pendingUserMessage) {
    span.setAttribute(
      "gen_ai.input.messages",
      JSON.stringify([
        {
          role: "user",
          parts: [{ type: "text", content: state.pendingUserMessage }],
        },
      ]),
    )
    state.pendingUserMessage = undefined
  }

  state.chatSpan = span
  return span
}

function closeSessionState(sessionId: string, statusCode = SpanStatusCode.OK): void {
  const state = sessionStates.get(sessionId)
  if (!state) {
    return
  }

  for (const toolSpan of state.activeToolSpans.values()) {
    toolSpan.setStatus({ code: statusCode })
    toolSpan.end()
  }
  state.activeToolSpans.clear()

  if (state.chatSpan) {
    state.chatSpan.setStatus({ code: statusCode })
    state.chatSpan.end()
    state.chatSpan = null
  }
}

function getToolCallKey(event: any): string {
  return (
    asString(event?.properties?.callId) ??
    asString(event?.properties?.id) ??
    asString(event?.properties?.name) ??
    "tool"
  )
}

function startToolCallSpan(sessionId: string, event: any): Span {
  const state = getSessionState(sessionId)
  const key = getToolCallKey(event)
  const existing = state.activeToolSpans.get(key)
  if (existing) {
    return existing
  }

  const chatSpan = ensureChatSpan(sessionId, event)
  const parentContext = trace.setSpan(context.active(), chatSpan)
  const toolName = asString(event?.properties?.name) ?? "unknown"

  const attributes: Record<string, string> = {
    ...getBaseAttributes(sessionId, event),
    "mcp.method.name": "tools/call",
    "gen_ai.operation.name": "execute_tool",
    "gen_ai.tool.name": toolName,
  }

  const inputJson = toJson(event?.properties?.input)
  if (inputJson) {
    attributes["gen_ai.tool.call.arguments"] = inputJson
  }

  const span = tracer!.startSpan(
    `tools/call ${toolName}`,
    {
      kind: SpanKind.CLIENT,
      attributes,
    },
    parentContext,
  )

  state.activeToolSpans.set(key, span)
  return span
}

export const OtelSemanticsExporterPlugin: Plugin = async ({ project, client, $, directory, worktree }) => {
  const config = loadConfigFromEnv()
  
  console.log(`[otel-exporter] Initializing OpenTelemetry exporter (${config.format})`)
  
  try {
    exporter = await loadExporter(config)
    await exporter.initialize()
    
    provider = new NodeTracerProvider({
      resource: new Resource({
        [ATTR_SERVICE_NAME]: SERVICE_NAME,
        [ATTR_SERVICE_VERSION]: SERVICE_VERSION,
        "mcp.protocol.version": MCP_PROTOCOL_VERSION,
      }),
      spanProcessors: [new SpanForwarder(exporter, config.batching)],
    })
    
    provider.register()
    tracer = trace.getTracer("opencode")
  } catch (error) {
    console.error("[otel-exporter] Failed to initialize:", error)
    throw error
  }
  
  return {
    event: async ({ event }) => {
      try {
        const sessionId = extractSessionId(event)
        if (!sessionId) {
          return
        }

        const state = getSessionState(sessionId)
        
        switch (event.type) {
          case "tool.execute.before":
          case "tool.execute": {
            startToolCallSpan(sessionId, event)
            break
          }

          case "tool.result": {
            const key = getToolCallKey(event)
            const toolSpan = state.activeToolSpans.get(key) ?? startToolCallSpan(sessionId, event)
            const outputJson = toJson(event?.properties?.output)
            if (outputJson) {
              toolSpan.setAttribute("gen_ai.tool.call.result", outputJson)
            }
            toolSpan.setStatus({ code: SpanStatusCode.OK })
            break
          }

          case "tool.execute.after": {
            const key = getToolCallKey(event)
            const toolSpan = state.activeToolSpans.get(key) ?? startToolCallSpan(sessionId, event)
            toolSpan.setStatus({ code: SpanStatusCode.OK })
            toolSpan.end()
            state.activeToolSpans.delete(key)
            break
          }

          case "message.updated":
          case "message.part.updated": {
            const part = event?.properties?.part
            const partType = asString(part?.type)
            const role = extractRole(event)

            if (partType === "text") {
              const text = extractTextContent(part)
              if (text && role === "user") {
                closeSessionState(sessionId)
                state.pendingUserMessage = text
              } else if (text) {
                const chatSpan = ensureChatSpan(sessionId, event)
                chatSpan.setAttribute(
                  "gen_ai.output.messages",
                  JSON.stringify([
                    {
                      role: "assistant",
                      parts: [{ type: "text", content: text }],
                      finish_reason: "stop",
                    },
                  ]),
                )
              }
            }

            if (partType === "snapshot" || partType === "reasoning") {
              const reasoning = extractTextContent(part)
              if (reasoning) {
                const chatSpan = ensureChatSpan(sessionId, event)
                const parentContext = trace.setSpan(context.active(), chatSpan)
                const thinkingSpan = tracer!.startSpan(
                  "thinking",
                  {
                    kind: SpanKind.INTERNAL,
                    attributes: getBaseAttributes(sessionId, event),
                  },
                  parentContext,
                )
                thinkingSpan.setAttribute(
                  "gen_ai.output.messages",
                  JSON.stringify([
                    {
                      role: "assistant",
                      parts: [{ type: "reasoning", content: reasoning }],
                      finish_reason: "stop",
                    },
                  ]),
                )
                thinkingSpan.setStatus({ code: SpanStatusCode.OK })
                thinkingSpan.end()
              }
            }
            break
          }

          case "session.updated": {
            closeSessionState(sessionId)
            break
          }

          case "session.idle":
          case "session.completed": {
            closeSessionState(sessionId, SpanStatusCode.OK)
            break
          }

          case "session.error": {
            closeSessionState(sessionId, SpanStatusCode.ERROR)
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
      if (tracer && provider && exporter) {
        try {
          for (const sessionId of sessionStates.keys()) {
            closeSessionState(sessionId)
          }
          sessionStates.clear()

          await provider.shutdown()
          await exporter.shutdown()
          console.log("[otel-exporter] OpenTelemetry provider and exporter shut down")
        } catch (error) {
          console.error("[otel-exporter] Error shutting down provider:", error)
        }
      }
    },
  }
}

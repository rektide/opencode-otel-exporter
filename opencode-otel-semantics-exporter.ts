import type { Plugin } from "@opencode-ai/plugin"
import { context, trace, metrics, SpanStatusCode, SpanKind } from "@opentelemetry/api"
import type { Span, Tracer, Meter, Counter } from "@opentelemetry/api"
import { Resource } from "@opentelemetry/resources"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics"
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http"
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions"
import { loadExporter, loadConfigFromEnv, SpanForwarder } from "./exporters/index.js"

const SERVICE_NAME = "opencode-otel-exporter"
const SERVICE_VERSION = "1.0.0"
const MCP_PROTOCOL_VERSION = "2025-06-18"

let tracer: Tracer | null = null
let provider: NodeTracerProvider | null = null
let exporter: Awaited<ReturnType<typeof loadExporter>> | null = null
let meterProvider: MeterProvider | null = null
let meter: Meter | null = null
let tokenCounter: Counter | null = null

interface SessionTraceState {
  chatSpan: Span | null
  activeToolSpans: Map<string, Span>
  pendingUserMessage?: string
  totalInputTokens: number
  totalOutputTokens: number
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
      totalInputTokens: 0,
      totalOutputTokens: 0,
    }
    sessionStates.set(sessionId, state)
  }

  return state
}

interface TokenUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}

interface ErrorAttributes {
  type: string
  message?: string
  rpcStatusCode?: string
}

function extractErrorAttributes(
  event: any,
  defaultType?: string,
): ErrorAttributes | null {
  const error =
    event?.properties?.error ??
    event?.properties?.info?.error ??
    event?.properties?.result?.error ??
    event?.properties?.output?.error ??
    event?.error

  const rpcStatusCode =
    asString(event?.properties?.rpc?.response?.status_code) ??
    asString(event?.properties?.rpcStatusCode) ??
    asString(event?.properties?.statusCode) ??
    asString(error?.code)

  const status = asString(event?.properties?.status)?.toLowerCase()
  const state = asString(event?.properties?.state)?.toLowerCase()
  const hasExplicitError = error !== undefined && error !== null
  const indicatesFailure =
    status === "error" ||
    status === "failed" ||
    state === "error" ||
    state === "failed" ||
    event?.properties?.ok === false ||
    event?.properties?.success === false ||
    event?.properties?.output?.isError === true

  const type =
    asString(error?.type) ??
    asString(error?.name) ??
    asString(event?.properties?.errorType) ??
    (hasExplicitError || indicatesFailure ? rpcStatusCode : undefined) ??
    (typeof error === "string" ? error : undefined) ??
    (indicatesFailure ? defaultType : undefined)

  if (!type) {
    return null
  }

  const message =
    asString(error?.message) ??
    asString(event?.properties?.message) ??
    (typeof error === "string" ? error : undefined)

  return {
    type,
    message,
    rpcStatusCode,
  }
}

function applyErrorAttributes(span: Span, error: ErrorAttributes): void {
  span.setAttribute("error.type", error.type)

  if (error.rpcStatusCode) {
    span.setAttribute("rpc.response.status_code", error.rpcStatusCode)
  }

  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: error.message,
  })
}

function extractTokenUsage(event: any): TokenUsage | null {
  const usage = 
    event?.properties?.info?.usage ??
    event?.properties?.usage ??
    event?.properties?.part?.usage ??
    event?.properties?.info?.message?.usage

  if (!usage) {
    return null
  }

  return {
    inputTokens: 
      usage.input_tokens ?? 
      usage.promptTokens ?? 
      usage.prompt_tokens,
    outputTokens: 
      usage.output_tokens ?? 
      usage.completionTokens ?? 
      usage.completion_tokens,
    totalTokens: 
      usage.total_tokens ?? 
      usage.totalTokens,
  }
}

function recordTokenMetrics(sessionId: string, usage: TokenUsage): void {
  const state = getSessionState(sessionId)

  const inputDelta = usage.inputTokens ?? 0
  const outputDelta = usage.outputTokens ?? 0

  state.totalInputTokens += inputDelta
  state.totalOutputTokens += outputDelta

  if (tokenCounter && (inputDelta > 0 || outputDelta > 0)) {
    tokenCounter.add(inputDelta + outputDelta, {
      "gen_ai.conversation.id": sessionId,
      "gen_ai.token.type": "total",
    })
    
    if (inputDelta > 0) {
      tokenCounter.add(inputDelta, {
        "gen_ai.conversation.id": sessionId,
        "gen_ai.token.type": "input",
      })
    }
    
    if (outputDelta > 0) {
      tokenCounter.add(outputDelta, {
        "gen_ai.conversation.id": sessionId,
        "gen_ai.token.type": "output",
      })
    }
  }
}

function addTokenAttributes(span: Span, sessionId: string): void {
  const state = getSessionState(sessionId)
  
  if (state.totalInputTokens > 0) {
    span.setAttribute("gen_ai.usage.input_tokens", state.totalInputTokens)
  }
  
  if (state.totalOutputTokens > 0) {
    span.setAttribute("gen_ai.usage.output_tokens", state.totalOutputTokens)
  }
}

function getBaseAttributes(
  sessionId: string,
  event: any,
): Record<string, string> {
  const attributes: Record<string, string> = {
    "gen_ai.conversation.id": sessionId,
    "mcp.session.id": sessionId,
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

function closeSessionState(
  sessionId: string,
  errorAttributes?: ErrorAttributes,
): void {
  const state = sessionStates.get(sessionId)
  if (!state) {
    return
  }

  for (const toolSpan of state.activeToolSpans.values()) {
    if (errorAttributes) {
      applyErrorAttributes(toolSpan, errorAttributes)
    }
    toolSpan.end()
  }
  state.activeToolSpans.clear()

  if (state.chatSpan) {
    addTokenAttributes(state.chatSpan, sessionId)

    if (errorAttributes) {
      applyErrorAttributes(state.chatSpan, errorAttributes)
    }

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

  const callId = asString(event?.properties?.callId)
  if (callId) {
    attributes["jsonrpc.request.id"] = callId
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
    
    const resource = new Resource({
      [ATTR_SERVICE_NAME]: SERVICE_NAME,
      [ATTR_SERVICE_VERSION]: SERVICE_VERSION,
      "mcp.protocol.version": MCP_PROTOCOL_VERSION,
    })
    
    provider = new NodeTracerProvider({
      resource,
      spanProcessors: [new SpanForwarder(exporter, config.batching)],
    })
    
    provider.register()
    tracer = trace.getTracer("opencode")

    const metricsUrl = process.env.OPENTELEMETRY_METRICS_URL
    if (metricsUrl) {
      console.log(`[otel-metrics] Initializing metrics exporter: ${metricsUrl}`)
      
      const metricsExporter = new OTLPMetricExporter({
        url: metricsUrl,
      })
      
      const metricsReader = new PeriodicExportingMetricReader({
        exporter: metricsExporter,
        exportIntervalMillis: parseInt(
          process.env.OPENTELEMETRY_METRICS_INTERVAL ?? "60000",
          10
        ),
      })
      
      meterProvider = new MeterProvider({
        resource,
        readers: [metricsReader],
      })
      
      meter = meterProvider.getMeter("opencode")
      tokenCounter = meter.createCounter("gen_ai.client.token.usage", {
        description: "Number of tokens used in AI operations",
        unit: "{token}",
      })
      
      console.log("[otel-metrics] Metrics exporter initialized")
    }
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

            const errorAttributes = extractErrorAttributes(event, "tool_error")
            if (errorAttributes) {
              applyErrorAttributes(toolSpan, errorAttributes)
            }
            break
          }

          case "tool.execute.after": {
            const key = getToolCallKey(event)
            const toolSpan = state.activeToolSpans.get(key) ?? startToolCallSpan(sessionId, event)

            const errorAttributes = extractErrorAttributes(event, "tool_error")
            if (errorAttributes) {
              applyErrorAttributes(toolSpan, errorAttributes)
            }

            toolSpan.end()
            state.activeToolSpans.delete(key)
            break
          }

          case "message.updated":
          case "message.part.updated": {
            const usage = extractTokenUsage(event)
            if (usage) {
              recordTokenMetrics(sessionId, usage)
            }

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
                addTokenAttributes(chatSpan, sessionId)
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
            closeSessionState(sessionId)
            break
          }

          case "session.error": {
            closeSessionState(sessionId, extractErrorAttributes(event, "session_error") ?? {
              type: "session_error",
            })
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
          
          if (meterProvider) {
            await meterProvider.shutdown()
            console.log("[otel-metrics] Metrics provider shut down")
          }
          
          console.log("[otel-exporter] OpenTelemetry provider and exporter shut down")
        } catch (error) {
          console.error("[otel-exporter] Error shutting down provider:", error)
        }
      }
    },
  }
}

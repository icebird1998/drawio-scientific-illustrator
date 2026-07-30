#!/usr/bin/env node

import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { drawioInstallHint, resolveDrawioExecutable } from "./drawio-path.mjs";

const SERVER_NAME = "drawio-live";
const SERVER_VERSION = "1.0.0";
const DRAWIO = resolveDrawioExecutable();
const DEFAULT_PORT = Number(process.env.DRAWIO_LIVE_PORT || 9333);
const PROFILE_ROOT = process.env.DRAWIO_LIVE_PROFILE || path.join(os.homedir(), ".drawio-live-mcp");
const SUPPORTED_PROTOCOLS = new Set(["2024-11-05", "2025-03-26", "2025-06-18"]);

const live = {
  process: null,
  cdp: null,
  port: DEFAULT_PORT,
  target: null,
  stepDelayMs: 350,
};

const pointSchema = {
  type: "object",
  required: ["x", "y"],
  properties: { x: { type: "number" }, y: { type: "number" } },
  additionalProperties: false,
};

const shapeProperties = {
  id: { type: "string", description: "Stable cell id used by later edges/updates." },
  label: { type: "string", default: "" },
  shape: {
    type: "string",
    enum: ["rectangle", "rounded", "ellipse", "diamond", "cylinder", "hexagon", "triangle", "parallelogram", "cloud", "text", "swimlane"],
    default: "rounded",
  },
  x: { type: "number" },
  y: { type: "number" },
  width: { type: "number", exclusiveMinimum: 0 },
  height: { type: "number", exclusiveMinimum: 0 },
  style: { type: "string", description: "Full draw.io style override." },
  fill_color: { type: "string" },
  stroke_color: { type: "string" },
  font_color: { type: "string" },
  font_size: { type: "number", minimum: 1, maximum: 200 },
  stroke_width: { type: "number", minimum: 0, maximum: 50 },
};

const tools = [
  {
    name: "drawio_live_launch",
    description:
      "Launch or connect to a visible draw.io desktop window with a localhost-only debugging channel. Shapes added through the live tools appear immediately on screen. This does not pre-generate a diagram file.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Optional existing .drawio file to open visibly." },
        port: { type: "integer", minimum: 1024, maximum: 65535, default: 9333 },
        step_delay_ms: { type: "integer", minimum: 0, maximum: 10000, default: 350 },
        maximize: { type: "boolean", default: true },
        include_screenshot: { type: "boolean", default: false },
      },
      additionalProperties: false,
    },
  },
  {
    name: "drawio_live_status",
    description: "Report whether the visible draw.io editor and live graph are ready, including page title, viewport, zoom, and cell counts.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "drawio_live_screenshot",
    description: "Capture the current visible draw.io renderer so the model can decide the next drawing action and the user can review progress.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "drawio_live_clear",
    description: "Remove the current page's drawable cells in the visible editor to start a blank live drawing. The change is visible and undoable in draw.io.",
    inputSchema: {
      type: "object",
      properties: { confirm: { type: "boolean", description: "Must be true because this removes current page content." } },
      required: ["confirm"],
      additionalProperties: false,
    },
  },
  {
    name: "drawio_live_add_shape",
    description: "Add one editable shape directly to the currently visible draw.io canvas. The shape appears immediately; no XML file is opened.",
    inputSchema: {
      type: "object",
      required: ["id", "x", "y", "width", "height"],
      properties: { ...shapeProperties, pause_after_ms: { type: "integer", minimum: 0, maximum: 10000 } },
      additionalProperties: false,
    },
  },
  {
    name: "drawio_live_add_edge",
    description: "Add one editable connector directly between two visible draw.io cells. The edge appears immediately.",
    inputSchema: {
      type: "object",
      required: ["id", "source", "target"],
      properties: {
        id: { type: "string" },
        source: { type: "string" },
        target: { type: "string" },
        label: { type: "string", default: "" },
        style: { type: "string" },
        color: { type: "string" },
        width: { type: "number", minimum: 0, maximum: 50 },
        dashed: { type: "boolean" },
        curved: { type: "boolean" },
        start_arrow: { type: "string" },
        end_arrow: { type: "string" },
        exit_x: { type: "number", minimum: 0, maximum: 1 },
        exit_y: { type: "number", minimum: 0, maximum: 1 },
        entry_x: { type: "number", minimum: 0, maximum: 1 },
        entry_y: { type: "number", minimum: 0, maximum: 1 },
        waypoints: { type: "array", maxItems: 100, items: pointSchema },
        pause_after_ms: { type: "integer", minimum: 0, maximum: 10000 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "drawio_live_update_cell",
    description: "Change one existing visible cell's label, full style, position, or size in place. The edit appears immediately and participates in draw.io undo.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string" },
        label: { type: "string" },
        style: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
        width: { type: "number", exclusiveMinimum: 0 },
        height: { type: "number", exclusiveMinimum: 0 },
        pause_after_ms: { type: "integer", minimum: 0, maximum: 10000 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "drawio_live_draw_sequence",
    description:
      "Execute a paced sequence of shape, edge, update, fit, and wait operations in the visible draw.io editor. Each operation is applied separately with a delay so the user can watch the drawing process.",
    inputSchema: {
      type: "object",
      required: ["operations"],
      properties: {
        operations: {
          type: "array",
          minItems: 1,
          maxItems: 500,
          items: { type: "object", description: "An operation with type: shape, edge, update, fit, or wait." },
        },
        step_delay_ms: { type: "integer", minimum: 0, maximum: 10000 },
        screenshot_after: { type: "boolean", default: true },
      },
      additionalProperties: false,
    },
  },
  {
    name: "drawio_live_fit",
    description: "Fit the current live diagram into the visible draw.io window or set a specific zoom percentage.",
    inputSchema: {
      type: "object",
      properties: { zoom_percent: { type: "number", minimum: 10, maximum: 800 } },
      additionalProperties: false,
    },
  },
  {
    name: "drawio_live_inspect",
    description: "Read a compact inventory of cells from the currently visible draw.io model for subsequent live edits.",
    inputSchema: {
      type: "object",
      properties: { max_cells: { type: "integer", minimum: 1, maximum: 2000, default: 500 } },
      additionalProperties: false,
    },
  },
  {
    name: "drawio_live_save_snapshot",
    description:
      "Save the current already-visible live draw.io model to an uncompressed .drawio file. This serializes the canvas after live drawing; it does not construct XML first and then open it.",
    inputSchema: {
      type: "object",
      required: ["output_path"],
      properties: {
        output_path: { type: "string" },
        page_name: { type: "string", default: "Live drawing" },
        overwrite: { type: "boolean", default: false },
      },
      additionalProperties: false,
    },
  },
];

class CdpClient {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out connecting to draw.io debugging channel.")), 10000);
      this.ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      this.ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Failed to connect to draw.io debugging channel.")); }, { once: true });
    });
    this.ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else pending.resolve(message.result);
    });
    this.ws.addEventListener("close", () => {
      for (const pending of this.pending.values()) pending.reject(new Error("draw.io debugging channel closed."));
      this.pending.clear();
    });
  }

  call(method, params = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error("draw.io live session is not connected.");
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        try { this.ws?.close(); } catch {}
        reject(new Error(`CDP method timed out: ${method}`));
      }, 30000);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function xmlEscape(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function ensureStyle(style = "") {
  return style && !style.endsWith(";") ? `${style};` : style;
}

function setStyle(style, key, value) {
  if (value === undefined || value === null) return style;
  const entries = ensureStyle(style).split(";").filter(Boolean);
  const filtered = entries.filter((entry) => entry.split("=", 1)[0] !== key);
  filtered.push(`${key}=${value}`);
  return `${filtered.join(";")};`;
}

function shapeStyle(shape = "rounded") {
  const common = "whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;fontColor=#1f2937;";
  const map = {
    rectangle: `rounded=0;${common}`,
    rounded: `rounded=1;${common}`,
    ellipse: `ellipse;${common}`,
    diamond: `rhombus;${common}`,
    cylinder: `shape=cylinder3;boundedLbl=1;backgroundOutline=1;${common}`,
    hexagon: `shape=hexagon;perimeter=hexagonPerimeter2;fixedSize=1;${common}`,
    triangle: `triangle;${common}`,
    parallelogram: `shape=parallelogram;perimeter=parallelogramPerimeter;${common}`,
    cloud: `ellipse;shape=cloud;${common}`,
    text: "text;strokeColor=none;fillColor=none;align=center;verticalAlign=middle;whiteSpace=wrap;html=1;fontColor=#1f2937;",
    swimlane: "swimlane;startSize=30;rounded=0;html=1;whiteSpace=wrap;fillColor=#f5f5f5;strokeColor=#666666;",
  };
  return map[shape] || map.rounded;
}

function edgeStyle(args) {
  let style = args.style || "edgeStyle=orthogonalEdgeStyle;rounded=1;orthogonalLoop=1;jettySize=auto;html=1;endArrow=block;endFill=1;";
  style = setStyle(style, "strokeColor", args.color);
  style = setStyle(style, "strokeWidth", args.width);
  if (args.dashed !== undefined) style = setStyle(style, "dashed", args.dashed ? 1 : 0);
  if (args.curved !== undefined) style = setStyle(style, "curved", args.curved ? 1 : 0);
  style = setStyle(style, "startArrow", args.start_arrow);
  style = setStyle(style, "endArrow", args.end_arrow);
  style = setStyle(style, "exitX", args.exit_x);
  style = setStyle(style, "exitY", args.exit_y);
  style = setStyle(style, "entryX", args.entry_x);
  style = setStyle(style, "entryY", args.entry_y);
  return ensureStyle(style);
}

function rpcError(id, code, message, data) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function toolResult(value, { imageData, isError = false } = {}) {
  const content = [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }];
  if (imageData) content.push({ type: "image", data: imageData, mimeType: "image/png" });
  return {
    content,
    ...(typeof value === "object" && value !== null ? { structuredContent: value } : {}),
    isError,
  };
}

async function jsonEndpoint(port, endpoint) {
  const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, { signal: AbortSignal.timeout(2000) });
  if (!response.ok) throw new Error(`Debug endpoint returned ${response.status}.`);
  return response.json();
}

async function findTarget(port) {
  const targets = await jsonEndpoint(port, "/json/list");
  const pages = targets.filter((target) => target.type === "page" && target.webSocketDebuggerUrl);
  return pages.find((target) => /draw\.io|diagrams\.net/i.test(`${target.title} ${target.url}`)) || null;
}

async function canListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port }, () => server.close(() => resolve(true)));
  });
}

async function findAvailablePort(startPort) {
  for (let port = startPort; port < Math.min(65535, startPort + 100); port += 1) {
    if (await canListen(port)) return port;
  }
  throw new Error(`No free localhost port found near ${startPort}.`);
}

async function waitForTarget(port, timeoutMs = 25000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const target = await findTarget(port);
      if (target) return target;
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }
  throw new Error(`draw.io opened but no debuggable editor page appeared.${lastError ? ` ${lastError.message}` : ""}`);
}

async function connectTarget(target) {
  if (live.cdp?.ws?.readyState === WebSocket.OPEN && live.target?.id === target.id) return;
  try { live.cdp?.ws?.close(); } catch {}
  const cdp = new CdpClient(target.webSocketDebuggerUrl);
  try {
    await cdp.connect();
    live.cdp = cdp;
    live.target = target;
    await cdp.call("Runtime.enable");
    await cdp.call("Page.enable");
    await cdp.call("Page.bringToFront").catch(() => {});
    await sleep(300);
    await recoverGraphReference().catch(() => false);
  } catch (error) {
    try { cdp.ws?.close(); } catch {}
    if (live.cdp === cdp) {
      live.cdp = null;
      live.target = null;
    }
    throw error;
  }
}

async function ensureConnected() {
  if (live.cdp?.ws?.readyState === WebSocket.OPEN) return;
  const target = await waitForTarget(live.port, 5000);
  await connectTarget(target);
}

async function evaluate(expression, { awaitPromise = true } = {}) {
  await ensureConnected();
  const result = await live.cdp.call("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    const description = result.exceptionDetails.exception?.description || result.exceptionDetails.text || "draw.io evaluation failed.";
    throw new Error(description);
  }
  return result.result?.value;
}

async function getRemoteProperties(objectId, ownProperties = true) {
  const result = await live.cdp.call("Runtime.getProperties", {
    objectId,
    ownProperties,
    accessorPropertiesOnly: false,
    generatePreview: true,
  });
  return result;
}

async function bindRemoteGraph(objectId) {
  const result = await live.cdp.call("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: "function(){ window.__codexDrawioGraph = this; return !!(this && this.getModel && this.insertVertex); }",
    returnByValue: true,
    userGesture: true,
  });
  return result.result?.value === true;
}

async function recoverGraphReference() {
  const existing = await live.cdp.call("Runtime.evaluate", {
    expression: "!!(window.__codexDrawioGraph && window.__codexDrawioGraph.getModel && window.__codexDrawioGraph.insertVertex)",
    returnByValue: true,
  });
  if (existing.result?.value === true) return true;

  const listeners = await live.cdp.call("Runtime.evaluate", {
    expression: "document.querySelector('.geDiagramContainer')?.mxListenerList?.map((item) => item.f).filter(Boolean) || []",
    returnByValue: false,
  });
  const listId = listeners.result?.objectId;
  if (!listId) return false;
  const listProps = await getRemoteProperties(listId, true);
  const functions = listProps.result.filter((prop) => /^\d+$/.test(prop.name) && prop.value?.objectId).slice(0, 40);

  for (const fnProp of functions) {
    const fnProps = await getRemoteProperties(fnProp.value.objectId, false);
    const scopesId = fnProps.internalProperties?.find((prop) => prop.name === "[[Scopes]]")?.value?.objectId;
    if (!scopesId) continue;
    const scopeList = await getRemoteProperties(scopesId, true);
    for (const scopeProp of scopeList.result.filter((prop) => /^\d+$/.test(prop.name) && prop.value?.objectId && /Closure/i.test(prop.value.description || ""))) {
      const scope = await getRemoteProperties(scopeProp.value.objectId, true);
      for (const variable of scope.result) {
        const remote = variable.value;
        if (!remote?.objectId || remote.type !== "object") continue;
        if (remote.className === "Graph" && await bindRemoteGraph(remote.objectId)) return true;
        if (!/^(?:mxCellEditor|EditorUi|Editor|Graph|Object)$/.test(remote.className || "") && variable.name !== "a") continue;
        const objectProps = await getRemoteProperties(remote.objectId, true).catch(() => null);
        const graphProp = objectProps?.result?.find((prop) => prop.name === "graph" && prop.value?.objectId && prop.value.className === "Graph");
        if (graphProp && await bindRemoteGraph(graphProp.value.objectId)) return true;
      }
    }
  }
  return false;
}

const graphLookup = `
  const __findUi = () => {
    for (const key of ['ui', 'editorUi', 'app']) {
      try { if (window[key] && window[key].editor && window[key].editor.graph) return window[key]; } catch {}
    }
    for (const key of Object.keys(window)) {
      try {
        const value = window[key];
        if (value && typeof value === 'object' && value.editor && value.editor.graph && value.editor.graph.getModel) return value;
      } catch {}
    }
    return null;
  };
  const ui = __findUi();
  const graph = window.__codexDrawioGraph || (ui && ui.editor && ui.editor.graph);
  if (!graph) throw new Error('The draw.io editor graph is not ready. Ensure a blank or existing diagram is open in draw.io.');
`;

async function graphEval(body) {
  await ensureConnected();
  await recoverGraphReference();
  return evaluate(`(() => { ${graphLookup} ${body} })()`);
}

async function liveStatus() {
  await ensureConnected();
  await recoverGraphReference().catch(() => false);
  return evaluate(`(() => {
    const foundUi = (() => {
      for (const key of ['ui', 'editorUi', 'app']) { try { if (window[key]?.editor?.graph) return window[key]; } catch {} }
      for (const key of Object.keys(window)) { try { if (window[key]?.editor?.graph?.getModel) return window[key]; } catch {} }
      return null;
    })();
    const graph = window.__codexDrawioGraph || foundUi?.editor?.graph;
    const base = { title: document.title, url: location.href, viewport: { width: innerWidth, height: innerHeight }, graph_ready: !!graph, control_scope: 'draw.io graph API only' };
    if (!graph) return base;
    const parent = graph.getDefaultParent();
    return { ...base, zoom_percent: Math.round(graph.view.scale * 100), vertices: graph.getChildVertices(parent).length, edges: graph.getChildEdges(parent).length };
  })()`);
}

async function captureScreenshot() {
  await ensureConnected();
  const { data } = await live.cdp.call("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
  return data;
}

async function addShape(args) {
  let style = args.style || shapeStyle(args.shape);
  style = setStyle(style, "fillColor", args.fill_color);
  style = setStyle(style, "strokeColor", args.stroke_color);
  style = setStyle(style, "fontColor", args.font_color);
  style = setStyle(style, "fontSize", args.font_size);
  style = setStyle(style, "strokeWidth", args.stroke_width);
  const payload = JSON.stringify({ ...args, style: ensureStyle(style) });
  const value = await graphEval(`
    const a = ${payload};
    if (graph.getModel().getCell(a.id)) throw new Error('Cell id already exists: ' + a.id);
    const parent = graph.getDefaultParent();
    let cell;
    graph.getModel().beginUpdate();
    try { cell = graph.insertVertex(parent, a.id, a.label || '', Number(a.x), Number(a.y), Number(a.width), Number(a.height), a.style); }
    finally { graph.getModel().endUpdate(); }
    graph.setSelectionCell(cell);
    graph.scrollCellToVisible(cell);
    return { id: cell.id, label: graph.convertValueToString(cell), geometry: cell.geometry, style: cell.style };
  `);
  await sleep(args.pause_after_ms ?? live.stepDelayMs);
  return value;
}

async function addEdge(args) {
  const payload = JSON.stringify({ ...args, style: edgeStyle(args) });
  const value = await graphEval(`
    const a = ${payload};
    const model = graph.getModel();
    if (model.getCell(a.id)) throw new Error('Cell id already exists: ' + a.id);
    const source = model.getCell(a.source);
    const target = model.getCell(a.target);
    if (!source || !target) throw new Error('Missing edge endpoint: ' + (!source ? a.source : a.target));
    const parent = graph.getDefaultParent();
    let edge;
    model.beginUpdate();
    try {
      edge = graph.insertEdge(parent, a.id, a.label || '', source, target, a.style);
      if (a.waypoints && a.waypoints.length) {
        const geo = edge.getGeometry().clone();
        geo.points = a.waypoints.map((p) => new mxPoint(Number(p.x), Number(p.y)));
        model.setGeometry(edge, geo);
      }
    } finally { model.endUpdate(); }
    graph.setSelectionCell(edge);
    return { id: edge.id, source: source.id, target: target.id, label: graph.convertValueToString(edge), style: edge.style };
  `);
  await sleep(args.pause_after_ms ?? live.stepDelayMs);
  return value;
}

async function updateCell(args) {
  const payload = JSON.stringify(args);
  const value = await graphEval(`
    const a = ${payload};
    const model = graph.getModel();
    const cell = model.getCell(a.id);
    if (!cell) throw new Error('Cell not found: ' + a.id);
    model.beginUpdate();
    try {
      if (a.label !== undefined) graph.cellLabelChanged(cell, a.label, false);
      if (a.style !== undefined) model.setStyle(cell, a.style);
      if (a.x !== undefined || a.y !== undefined || a.width !== undefined || a.height !== undefined) {
        if (!cell.geometry) throw new Error('Cell has no geometry: ' + a.id);
        const geo = cell.geometry.clone();
        if (a.x !== undefined) geo.x = Number(a.x);
        if (a.y !== undefined) geo.y = Number(a.y);
        if (a.width !== undefined) geo.width = Number(a.width);
        if (a.height !== undefined) geo.height = Number(a.height);
        model.setGeometry(cell, geo);
      }
    } finally { model.endUpdate(); }
    graph.setSelectionCell(cell);
    graph.scrollCellToVisible(cell);
    return { id: cell.id, label: graph.convertValueToString(cell), geometry: cell.geometry, style: cell.style };
  `);
  await sleep(args.pause_after_ms ?? live.stepDelayMs);
  return value;
}

async function fitView(zoomPercent) {
  return graphEval(`
    const zoom = ${zoomPercent === undefined ? "null" : Number(zoomPercent)};
    if (zoom == null) graph.fit(20, false, 20, true, false, true);
    else graph.zoomTo(zoom / 100, true);
    return { zoom_percent: Math.round(graph.view.scale * 100) };
  `);
}

async function launchLive(args) {
  live.port = args.port || DEFAULT_PORT;
  live.stepDelayMs = args.step_delay_ms ?? 350;
  let target = null;
  try { target = await findTarget(live.port); } catch {}
  if (!target) {
    if (!(await canListen(live.port))) {
      if (args.port) throw new Error(`Port ${live.port} is already in use by a non-draw.io process.`);
      live.port = await findAvailablePort(live.port + 1);
    }
    const profileDir = process.env.DRAWIO_LIVE_PROFILE || path.join(PROFILE_ROOT, String(live.port));
    await fs.mkdir(profileDir, { recursive: true });
    const argv = [
      `--remote-debugging-address=127.0.0.1`,
      `--remote-debugging-port=${live.port}`,
      `--user-data-dir=${profileDir}`,
      "--disable-features=CalculateNativeWinOcclusion",
    ];
    if (args.file_path) argv.push(path.resolve(args.file_path));
    live.process = spawn(DRAWIO.executable, argv, { detached: false, stdio: "ignore", windowsHide: false });
    await new Promise((resolve, reject) => {
      live.process.once("spawn", resolve);
      live.process.once("error", (error) => reject(new Error(`Unable to launch draw.io (${DRAWIO.executable}): ${error.message}. ${drawioInstallHint()}`)));
    });
    target = await waitForTarget(live.port);
  }
  await connectTarget(target);
  if (args.maximize !== false) {
    try {
      const result = await live.cdp.call("Browser.getWindowForTarget", { targetId: target.id });
      await live.cdp.call("Browser.setWindowBounds", { windowId: result.windowId, bounds: { windowState: "maximized" } });
    } catch {}
  }
  await sleep(1000);
  return { connected: true, port: live.port, drawio: DRAWIO, target: { id: target.id, title: target.title, url: target.url }, step_delay_ms: live.stepDelayMs, status: await liveStatus() };
}

async function handleTool(name, args = {}) {
  switch (name) {
    case "drawio_live_launch": {
      const result = await launchLive(args);
      return { value: result, imageData: args.include_screenshot === true ? await captureScreenshot() : undefined };
    }
    case "drawio_live_status":
      return { value: { connected: true, port: live.port, ...(await liveStatus()) } };
    case "drawio_live_screenshot":
      return { value: { ...(await liveStatus()), captured: true }, imageData: await captureScreenshot() };
    case "drawio_live_clear": {
      if (args.confirm !== true) throw new Error("confirm=true is required to clear the current page.");
      const value = await graphEval(`
        const parent = graph.getDefaultParent();
        const cells = graph.getChildCells(parent, true, true);
        graph.removeCells(cells, true);
        graph.clearSelection();
        return { removed: cells.length };
      `);
      await sleep(live.stepDelayMs);
      return { value };
    }
    case "drawio_live_add_shape":
      return { value: await addShape(args) };
    case "drawio_live_add_edge":
      return { value: await addEdge(args) };
    case "drawio_live_update_cell":
      return { value: await updateCell(args) };
    case "drawio_live_fit":
      return { value: await fitView(args.zoom_percent), imageData: await captureScreenshot() };
    case "drawio_live_draw_sequence": {
      const delay = args.step_delay_ms ?? live.stepDelayMs;
      const results = [];
      for (let index = 0; index < args.operations.length; index += 1) {
        const operation = args.operations[index];
        const type = operation.type;
        if (type === "shape") results.push({ index, type, result: await addShape({ ...operation, pause_after_ms: delay }) });
        else if (type === "edge") results.push({ index, type, result: await addEdge({ ...operation, pause_after_ms: delay }) });
        else if (type === "update") results.push({ index, type, result: await updateCell({ ...operation, pause_after_ms: delay }) });
        else if (type === "fit") { results.push({ index, type, result: await fitView(operation.zoom_percent) }); await sleep(delay); }
        else if (type === "wait") { const ms = Math.max(0, Math.min(10000, operation.ms ?? delay)); await sleep(ms); results.push({ index, type, waited_ms: ms }); }
        else throw new Error(`Unsupported sequence operation at index ${index}: ${type}`);
      }
      return { value: { operations_applied: results.length, results }, imageData: args.screenshot_after === true ? await captureScreenshot() : undefined };
    }
    case "drawio_live_inspect": {
      const maxCells = args.max_cells || 500;
      const value = await graphEval(`
        const parent = graph.getDefaultParent();
        const cells = graph.getChildCells(parent, true, true);
        const plain = cells.slice(0, ${maxCells}).map((cell) => ({
          id: cell.id,
          type: cell.vertex ? 'vertex' : cell.edge ? 'edge' : 'cell',
          label: graph.convertValueToString(cell),
          source: cell.source?.id,
          target: cell.target?.id,
          geometry: cell.geometry ? { x: cell.geometry.x, y: cell.geometry.y, width: cell.geometry.width, height: cell.geometry.height, relative: cell.geometry.relative, points: cell.geometry.points?.map((p) => ({ x: p.x, y: p.y })) } : null,
          style: cell.style || '',
        }));
        return { cells: plain, total: cells.length, truncated: cells.length > ${maxCells}, zoom_percent: Math.round(graph.view.scale * 100) };
      `);
      return { value };
    }
    case "drawio_live_save_snapshot": {
      const output = path.resolve(args.output_path);
      if (path.extname(output).toLowerCase() !== ".drawio") throw new Error("output_path must end with .drawio");
      try {
        await fs.access(output);
        if (!args.overwrite) throw new Error(`Output exists; pass overwrite=true: ${output}`);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const modelXml = await graphEval(`
        const codec = new mxCodec();
        const node = codec.encode(graph.getModel());
        return mxUtils.getXml(node);
      `);
      const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<mxfile host="Electron" modified="${new Date().toISOString()}" version="30.3.6">\n  <diagram id="live-page" name="${xmlEscape(args.page_name || "Live drawing")}">\n${modelXml}\n  </diagram>\n</mxfile>\n`;
      await fs.mkdir(path.dirname(output), { recursive: true });
      const temporary = `${output}.tmp-${process.pid}`;
      await fs.writeFile(temporary, xml, "utf8");
      await fs.rename(temporary, output);
      return { value: { output_path: output, bytes: Buffer.byteLength(xml), saved_from_visible_session: true } };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function handleMessage(message) {
  const { id, method, params } = message;
  if (method === "initialize") {
    const requested = params?.protocolVersion;
    return rpcResult(id, {
      protocolVersion: SUPPORTED_PROTOCOLS.has(requested) ? requested : "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions: "Control only draw.io's own graph API. Launch the visible editor, then add shapes and edges one at a time or in a paced sequence so the user can watch every operation appear. Never use OS-level mouse, keyboard, or screen control. Save a .drawio snapshot only after live drawing.",
    });
  }
  if (method === "ping") return rpcResult(id, {});
  if (method === "tools/list") return rpcResult(id, { tools });
  if (method === "tools/call") {
    try {
      const result = await handleTool(params?.name, params?.arguments || {});
      return rpcResult(id, toolResult(result.value, { imageData: result.imageData }));
    } catch (error) {
      return rpcResult(id, toolResult({ error: error.message, tool: params?.name }, { isError: true }));
    }
  }
  if (method?.startsWith("notifications/")) return null;
  return rpcError(id, -32601, `Method not found: ${method}`);
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
let requestQueue = Promise.resolve();

async function handleLine(line) {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); }
  catch (error) {
    process.stdout.write(`${JSON.stringify(rpcError(null, -32700, "Parse error", error.message))}\n`);
    return;
  }
  try {
    const response = await handleMessage(message);
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify(rpcError(message.id, -32603, "Internal error", error.message))}\n`);
  }
}

rl.on("line", (line) => {
  requestQueue = requestQueue.then(() => handleLine(line));
});

process.on("uncaughtException", (error) => process.stderr.write(`[${SERVER_NAME}] ${error.stack || error.message}\n`));
process.on("unhandledRejection", (error) => process.stderr.write(`[${SERVER_NAME}] ${error?.stack || error}\n`));

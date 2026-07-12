"use client";

import { useCallback, useMemo, useState } from "react";
import ReactFlow, { Background, Controls, MiniMap, addEdge, applyNodeChanges } from "reactflow";
import "reactflow/dist/style.css";
import { IconGitBranch, IconMessage, IconPlus, IconTrash, IconVolume } from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

function newNode(type, index) {
  const id = `n_${type}_${Date.now()}_${index}`;
  return { id, type, name: type === "speak" ? "Speak node" : "Prompt node", position: { x: 80 + index * 260, y: 100 + (index % 2) * 180 }, ...(type === "speak" ? { message: "" } : { instructions: "", instructions_mode: "append" }) };
}

function defaultFlow() { const node = newNode("prompt", 0); return { start_node_id: node.id, nodes: [node], edges: [] }; }

export default function WorkflowSettingsPanel({ values, setValues, models = [] }) {
  const flow = values.conversation_flow;
  const [selectedId, setSelectedId] = useState(flow?.start_node_id || "");
  const selected = flow?.nodes?.find((node) => node.id === selectedId);

  const canvasNodes = useMemo(() => (flow?.nodes || []).map((node) => ({ id: node.id, position: node.position || { x: 0, y: 0 }, data: { label: <div className="min-w-32"><div className="flex items-center gap-2 font-medium">{node.type === "speak" ? <IconVolume className="size-4 text-sky-500" /> : <IconMessage className="size-4 text-violet-500" />}{node.name || node.id}</div><div className="mt-1 text-[10px] text-muted-foreground">{flow.start_node_id === node.id ? "START · " : ""}{node.type || "prompt"}</div></div> }, style: { border: flow.start_node_id === node.id ? "2px solid #10b981" : "1px solid hsl(var(--border))", borderRadius: 12, background: "hsl(var(--card))", color: "hsl(var(--card-foreground))" } })), [flow]);
  const canvasEdges = useMemo(() => (flow?.edges || []).filter((edge) => edge.target?.type === "node").map((edge) => ({ id: edge.id, source: edge.start_node_id, target: edge.target.node_id, label: edge.condition || "", animated: true })), [flow]);

  function setFlow(next) { setValues((current) => ({ ...current, conversation_flow: next })); }
  function addNode(type) { const node = newNode(type, flow.nodes.length); setFlow({ ...flow, nodes: [...flow.nodes, node] }); setSelectedId(node.id); }
  function patchNode(patch) { setFlow({ ...flow, nodes: flow.nodes.map((node) => node.id === selectedId ? { ...node, ...patch } : node) }); }
  function deleteNode() { if (!selected) return; const nodes = flow.nodes.filter((node) => node.id !== selected.id); const edges = flow.edges.filter((edge) => edge.start_node_id !== selected.id && edge.target?.node_id !== selected.id); setFlow({ ...flow, nodes, edges, start_node_id: flow.start_node_id === selected.id ? nodes[0]?.id || "" : flow.start_node_id }); setSelectedId(nodes[0]?.id || ""); }
  const onConnect = useCallback((connection) => {
    const edge = { id: `e_${Date.now()}`, start_node_id: connection.source, condition: "", target: { type: "node", node_id: connection.target } };
    setValues((current) => ({ ...current, conversation_flow: { ...current.conversation_flow, edges: [...(current.conversation_flow?.edges || []), edge] } }));
  }, [setValues]);
  const onNodesChange = useCallback((changes) => {
    setValues((current) => {
      const currentFlow = current.conversation_flow;
      const reactNodes = (currentFlow?.nodes || []).map((node) => ({ id: node.id, position: node.position || { x: 0, y: 0 }, data: {} }));
      const changed = applyNodeChanges(changes, reactNodes);
      const positions = new Map(changed.map((node) => [node.id, node.position]));
      return { ...current, conversation_flow: { ...currentFlow, nodes: currentFlow.nodes.map((node) => ({ ...node, position: positions.get(node.id) || node.position })) } };
    });
  }, [setValues]);

  if (!flow) return <Card><CardHeader><CardTitle>Conversation workflow</CardTitle><CardDescription>Build a graph of prompt and speak nodes to control multi-stage assistant behavior.</CardDescription></CardHeader><CardContent><div className="rounded-xl border border-dashed p-12 text-center"><IconGitBranch className="mx-auto size-10 text-muted-foreground" /><h3 className="mt-4 font-semibold">Workflow mode is disabled</h3><p className="mx-auto mt-2 max-w-lg text-sm text-muted-foreground">Enable it to replace the single instruction prompt with a visual conversation flow.</p><Button className="mt-5" onClick={() => { const next = defaultFlow(); setFlow(next); setSelectedId(next.start_node_id); }}>Enable workflow</Button></div></CardContent></Card>;

  return <div className="space-y-4">
    <Card><CardHeader><div className="flex flex-wrap items-start justify-between gap-3"><div><CardTitle>Conversation workflow</CardTitle><CardDescription className="mt-1">Connect prompt and speak nodes. Select a node to edit its behavior.</CardDescription></div><div className="flex gap-2"><Button variant="outline" size="sm" onClick={() => addNode("prompt")}><IconPlus className="size-4" />Prompt</Button><Button variant="outline" size="sm" onClick={() => addNode("speak")}><IconPlus className="size-4" />Speak</Button><Button variant="outline" size="sm" className="text-destructive" onClick={() => setFlow(null)}>Disable</Button></div></div></CardHeader><CardContent><div className="h-[480px] overflow-hidden rounded-xl border bg-muted/20"><ReactFlow nodes={canvasNodes} edges={canvasEdges} onNodesChange={onNodesChange} onConnect={onConnect} onNodeClick={(_, node) => setSelectedId(node.id)} fitView><Background /><MiniMap pannable zoomable /><Controls /></ReactFlow></div></CardContent></Card>
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
      <Card><CardHeader><CardTitle>Transitions</CardTitle><CardDescription>Optional conditions decide which connected node runs next.</CardDescription></CardHeader><CardContent className="space-y-3">{flow.edges.map((edge) => <div key={edge.id} className="grid gap-2 rounded-lg border p-3 md:grid-cols-[1fr_auto_1fr_1.3fr_auto]"><Select value={edge.start_node_id} onValueChange={(value) => setFlow({ ...flow, edges: flow.edges.map((item) => item.id === edge.id ? { ...item, start_node_id: value } : item) })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{flow.nodes.map((node) => <SelectItem key={node.id} value={node.id}>{node.name}</SelectItem>)}</SelectContent></Select><span className="self-center text-muted-foreground">→</span><Select value={edge.target?.node_id || ""} onValueChange={(value) => setFlow({ ...flow, edges: flow.edges.map((item) => item.id === edge.id ? { ...item, target: { type: "node", node_id: value } } : item) })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{flow.nodes.map((node) => <SelectItem key={node.id} value={node.id}>{node.name}</SelectItem>)}</SelectContent></Select><Input value={edge.condition || ""} onChange={(event) => setFlow({ ...flow, edges: flow.edges.map((item) => item.id === edge.id ? { ...item, condition: event.target.value } : item) })} placeholder="Condition (optional)" /><Button variant="ghost" size="icon" className="text-destructive" onClick={() => setFlow({ ...flow, edges: flow.edges.filter((item) => item.id !== edge.id) })}><IconTrash className="size-4" /></Button></div>)}{!flow.edges.length ? <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">Drag between node handles to create a transition.</div> : null}</CardContent></Card>
      <Card><CardHeader><div className="flex items-center justify-between"><CardTitle>Node settings</CardTitle>{selected ? <Badge variant="secondary">{selected.type}</Badge> : null}</div><CardDescription>Edit the selected workflow node.</CardDescription></CardHeader><CardContent className="space-y-4">{selected ? <><div className="space-y-2"><Label>Name</Label><Input value={selected.name || ""} onChange={(event) => patchNode({ name: event.target.value })} /></div>{selected.type === "speak" ? <div className="space-y-2"><Label>Message</Label><Textarea rows={7} value={selected.message || ""} onChange={(event) => patchNode({ message: event.target.value })} placeholder="Text the assistant should speak" /></div> : <><div className="space-y-2"><Label>Instructions mode</Label><Select value={selected.instructions_mode || "append"} onValueChange={(value) => patchNode({ instructions_mode: value })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="append">Append to assistant instructions</SelectItem><SelectItem value="replace">Replace assistant instructions</SelectItem></SelectContent></Select></div><div className="space-y-2"><Label>Instructions</Label><Textarea rows={9} value={selected.instructions || ""} onChange={(event) => patchNode({ instructions: event.target.value })} /></div><div className="space-y-2"><Label>Model override</Label><Select value={selected.model || "__default__"} onValueChange={(value) => patchNode({ model: value === "__default__" ? undefined : value })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="__default__">Assistant default</SelectItem>{models.map((model) => <SelectItem key={model.id} value={model.id}>{model.name}</SelectItem>)}</SelectContent></Select></div></>}<div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" onClick={() => setFlow({ ...flow, start_node_id: selected.id })} disabled={flow.start_node_id === selected.id}>Set as start</Button><Button variant="outline" size="sm" className="text-destructive" onClick={deleteNode}><IconTrash className="size-4" />Delete</Button></div></> : <div className="text-sm text-muted-foreground">Select a node on the canvas.</div>}</CardContent></Card>
    </div>
  </div>;
}

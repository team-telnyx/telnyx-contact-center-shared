import os from "node:os";

function clean(value, fallback = "") {
  const text = String(value || "").trim();
  return text || fallback;
}

export function getLogNodeMetadata() {
  const hostname = clean(process.env.HOSTNAME, os.hostname());
  return {
    env: clean(process.env.APP_ENV || process.env.DEPLOY_GROUP || process.env.NODE_ENV, "unknown"),
    nodeId: clean(process.env.APP_NODE_ID || process.env.INSTANCE_ID || process.env.EC2_INSTANCE_ID, hostname),
    nodeName: clean(process.env.APP_NODE_NAME || process.env.INSTANCE_NAME || hostname, hostname),
    hostname,
    containerName: clean(process.env.APP_CONTAINER_NAME || process.env.CONTAINER_NAME, ""),
    processRole: clean(process.env.PROCESS_ROLE, "app"),
    pid: process.pid,
  };
}

export function enrichLogEntryWithNodeMetadata(entry = {}, metadata = getLogNodeMetadata()) {
  return {
    ...metadata,
    ...entry,
    env: entry.env || metadata.env,
    nodeId: entry.nodeId || metadata.nodeId,
    nodeName: entry.nodeName || metadata.nodeName,
    hostname: entry.hostname || metadata.hostname,
    containerName: entry.containerName || metadata.containerName,
    processRole: entry.processRole || metadata.processRole,
    pid: entry.pid || metadata.pid,
  };
}

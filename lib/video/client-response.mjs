export async function readVideoResponse(response) {
  const body = await response.json().catch(() => null);
  if (!response.ok || !body) throw new Error(body?.error || (response.status === 503
    ? "The video assistant service is unavailable. Please retry shortly."
    : "The video request could not be confirmed. Please refresh and try again."));
  return body;
}

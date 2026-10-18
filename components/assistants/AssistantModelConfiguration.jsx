"use client";
import { modelVisionCapability } from "@/lib/ai/vision-capabilities.mjs";
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useState,
  useCallback,
} from "react";
import { RefreshCw, Plus } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import AIModels from "./AIModels";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { useUiText } from "@/components/i18n/use-ui-text";
import {
  FASTROUTER_BASE_URL,
  modelOwner,
  modelProvider,
  providerOptions,
  switchExternalAuthentication,
  integrationSecretOptions,
  assistantCatalogModels,
  usesManualAssistantModelEntry,
} from "@/lib/ai/model-providers.mjs";

const CatalogContext = createContext(null);
function useCatalog(url, key) {
  const [state, setState] = useState({ items: [], loading: true, error: "" });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    fetch(url, { cache: "no-store", signal: controller.signal })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok || d.ok === false)
          throw new Error(d.error || `Request failed (${r.status})`);
        return d;
      })
      .then((d) => setState({ items: d[key] || [], loading: false, error: "" }))
      .catch((e) => {
        if (!controller.signal.aborted)
          setState((s) => ({ ...s, loading: false, error: e.message }));
      });
    return () => controller.abort();
  }, [url, key, revision]);
  const refresh = useCallback(() => {
    setState((s) => ({ ...s, loading: true, error: "" }));
    setRevision((r) => r + 1);
  }, []);
  return { ...state, refresh };
}
export function AssistantCatalogProvider({ children }) {
  const hosted = useCatalog("/api/ai/models", "models");
  const fast = useCatalog("/api/ai/models/fastrouter", "models");
  const secrets = useCatalog("/api/integration-secrets", "secrets");
  return (
    <CatalogContext.Provider value={{ hosted, fast, secrets }}>
      {children}
    </CatalogContext.Provider>
  );
}
export function IntegrationSecretField({
  value,
  onChange,
  label = "Integration secret",
  allowCreate = true,
  secretType = "bearer",
}) {
  const tUi = useUiText(),
    id = useId();
  const { secrets } = useContext(CatalogContext);
  const [creating, setCreating] = useState(false),
    [identifier, setIdentifier] = useState(""),
    [token, setToken] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const options = integrationSecretOptions(secrets.items, secretType);
  const saved = secrets.items.find(secret => secret.identifier === value);
  if (value && !options.some((s) => s.value === value))
    options.unshift({ value, label: `${value} (${saved?.type || tUi("saved reference")})`, disabled: Boolean(saved && secretType && saved.type !== secretType) });
  async function create() {
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/integration-secrets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier, type: "bearer", token }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d.error || "Could not create secret");
      onChange(d.secret.identifier);
      setToken("");
      setCreating(false);
      secrets.refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="text-sm font-medium">
        {tUi(label)}
      </label>
      {secrets.loading ? (
        <Skeleton className="h-9 w-full" />
      ) : (
        <div className="flex gap-2">
          <Combobox
            id={id}
            value={value || ""}
            onChange={onChange}
            options={[
              { value: "", label: tUi("No secret selected") },
              ...options,
            ]}
            triggerClassName="w-full"
            placeholder={tUi("Select integration secret…")}
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={secrets.refresh}
            aria-label={tUi("Refresh secrets")}
          >
            <RefreshCw className="size-4" />
          </Button>
          {allowCreate ? (
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={() => setCreating(!creating)}
              aria-label={tUi("Create integration secret")}
            >
              <Plus className="size-4" />
            </Button>
          ) : null}
        </div>
      )}
      {secrets.error ? (
        <p role="alert" className="text-xs text-destructive">
          {secrets.error}
        </p>
      ) : null}
      {creating ? (
        <div className="space-y-2 rounded-lg border p-3">
          <Input
            aria-label={tUi("Secret identifier")}
            placeholder={tUi("Secret identifier")}
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
          />
          <Input
            type="password"
            autoComplete="new-password"
            aria-label={tUi("Provider API key")}
            placeholder={tUi("Provider API key")}
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          <Button
            type="button"
            disabled={busy || !identifier.trim() || !token}
            onClick={create}
          >
            {tUi("Create secret")}
          </Button>
          <p className="text-xs text-muted-foreground">
            {tUi(
              "The key is stored in Telnyx. Only its reference is saved on the assistant.",
            )}
          </p>
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export default function AssistantModelConfiguration({
  value = {},
  onChange,
  ui = {},
  onUiChange = () => {},
  label = "Primary model",
  hideLegend = false,
  settingPath = "",
}) {
  const tUi = useUiText(),
    id = useId();
  // Where each control sits among the assistant's settings, for "Find setting"; the fallback model is prefixed.
  const at = (key) => (settingPath ? `${settingPath}.${key}` : key);
  const catalogs = useContext(CatalogContext);
  const hosted = catalogs.hosted.items;
  const provider = ui.provider || (value.external_llm ? modelProvider(value, hosted) : "all"),
    external = value.external_llm || {};
  const isExternal = ["fastrouter", "custom"].includes(provider),
    catalog = provider === "fastrouter" ? catalogs.fast : catalogs.hosted;
  const models =
    provider === "fastrouter"
      ? assistantCatalogModels(catalog.items)
      : assistantCatalogModels(hosted).filter((m) => provider === "all" || modelOwner(m) === provider);
  const model = isExternal ? external.model || "" : value.model || "";
  const selected = models.find((m) => m.id === model);
  const options = [{value: "all", label: tUi("All providers")}, ...providerOptions(hosted)];
  if (provider === "unlisted")
    options.push({
      value: "unlisted",
      label: tUi("Saved provider unavailable"),
    });
  const mode = ui.mode || "fixed";
  const manualModel = usesManualAssistantModelEntry(provider, mode, models.length);
  function setExternal(patch) {
    onChange({
      model: "",
      llm_api_key_ref: "",
      external_llm: { ...external, ...patch },
    });
  }
  function chooseProvider(next) {
    const drafts = {
      ...ui.drafts,
      [provider]: {
        model: value.model,
        llm_api_key_ref: value.llm_api_key_ref,
        external_llm: value.external_llm,
      },
    };
    onUiChange({ ...ui, provider: next, drafts, mode: undefined });
    onChange(
      (next === "all" && !isExternal ? value : drafts[next]) ||
        (next === "fastrouter" || next === "custom"
          ? {
              model: "",
              llm_api_key_ref: "",
              external_llm: {
                model: "",
                base_url: next === "fastrouter" ? FASTROUTER_BASE_URL : "",
                authentication_method: "token",
                forward_metadata: false,
              },
            }
          : { model: "", llm_api_key_ref: "", external_llm: null }),
    );
  }
  function setModel(next) {
    isExternal
      ? setExternal({ model: next })
      : onChange({ ...value, model: next, external_llm: null });
  }
  return (
    <fieldset data-model-config={label} data-setting-path={at("external_llm")} className="min-w-0 space-y-5">
      <legend className={hideLegend ? "sr-only" : "mb-4 text-base font-semibold"}>{tUi(label)}</legend>
      <div className="space-y-2">
        <label htmlFor={`${id}-provider`} className="text-sm font-medium">
          {tUi("LLM provider")}
        </label>
        <div className="flex gap-2">
          <Combobox
            id={`${id}-provider`}
            value={provider}
            onChange={chooseProvider}
            options={options}
            triggerClassName="w-full"
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            disabled={catalog.loading}
            onClick={() => {
              catalog.refresh();
              catalogs.secrets.refresh();
            }}
            aria-label={tUi("Refresh model catalog")}
          >
            <RefreshCw className="size-4" />
          </Button>
        </div>
      </div>
      {provider === "fastrouter" ? (
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor={`${id}-mode`}>
            {tUi("Routing mode")}
          </label>
          <Select value={mode} onValueChange={(mode) => onUiChange({ ...ui, mode })}>
            <SelectTrigger id={`${id}-mode`}><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="fixed">{tUi("Fixed model")}</SelectItem>
              <SelectItem value="virtual">{tUi("Virtual model")}</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {mode === "virtual"
              ? tUi(
                  "Enter the exact alias configured in FastRouter. Routing pools are managed in FastRouter.",
                )
              : FASTROUTER_BASE_URL}
          </p>
        </div>
      ) : null}
      {provider === "custom" ? (
        <div className="space-y-2" data-setting-path={at("external_llm.base_url")}>
          <label htmlFor={`${id}-url`} className="text-sm font-medium">
            {tUi("Base URL")}
          </label>
          <Input
            id={`${id}-url`}
            type="url"
            value={external.base_url || ""}
            placeholder="https://your-endpoint.example/v1"
            onChange={(e) => setExternal({ base_url: e.target.value })}
          />
        </div>
      ) : null}
      {catalog.loading ? <Skeleton className="h-4 w-48"/> : <p className="text-xs text-muted-foreground" role="status">{modelVisionCapability(value,hosted).reason} {tUi("Recommended for Vision: Kimi-K2.6.")}</p>}
      <div className="space-y-2" data-setting-path={isExternal ? at("external_llm.model") : at("model")}>
        <label htmlFor={`${id}-model`} className="text-sm font-medium">
          {provider === "fastrouter" && mode === "virtual"
            ? tUi("Virtual model alias")
            : tUi("Model")}
        </label>
        {provider !== "custom" && mode !== "virtual" && catalog.loading ? (
            <Skeleton className="h-9 w-full" />
          ) : !manualModel ? (
            <AIModels
              id={`${id}-model`}
              value={model}
              onValueChange={setModel}
              models={models}
              triggerClassName="border bg-background"
            />
        ) : (
          <Input
            id={`${id}-model`}
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={tUi("Enter the exact model identifier")}
            className="font-mono text-sm"
          />
        )}
        {model && !selected && !manualModel && !catalog.loading ? (
          <p className="text-xs text-muted-foreground">{tUi("Not in catalog")} · {model}</p>
        ) : null}
        {!isExternal && !model ? (
          <p className="text-xs text-muted-foreground">
            {tUi("Leave empty to use the Telnyx default model.")}
          </p>
        ) : null}
        {provider === "custom" || (provider === "fastrouter" && mode === "fixed" && manualModel) ? (
          <p className="text-xs text-muted-foreground">
            {tUi(
              "Enter the model ID from your endpoint. A model catalog is not required.",
            )}
          </p>
        ) : null}
        {catalog.error && provider !== "custom" ? (
          <p role="alert" className="text-xs text-destructive">
            {catalog.error}
          </p>
        ) : null}
        {selected ? (
          <p className="text-xs text-muted-foreground">
            {tUi("Context")}:{" "}
            {selected.raw?.context_length || tUi("Not published")} ·{" "}
            {selected.recommended_for_assistants
              ? tUi("Recommended for assistants")
              : tUi("Verify assistant capabilities before use")}
          </p>
        ) : null}
      </div>
      {isExternal && provider === "custom" ? (
        <div className="space-y-2" data-setting-path={at("external_llm.authentication_method")}>
          <label className="text-sm font-medium" htmlFor={`${id}-auth`}>
            {tUi("Authentication")}
          </label>
          <Select value={external.authentication_method || "token"} onValueChange={(method) => setExternal(switchExternalAuthentication(external, method))}>
            <SelectTrigger id={`${id}-auth`}><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="token">{tUi("Token")}</SelectItem>
              <SelectItem value="certificate">{tUi("Certificate")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      ) : null}
      {isExternal && external.authentication_method === "certificate" ? (
        <>
          <div data-setting-path={at("external_llm.certificate_ref")}>
          <IntegrationSecretField
            label="Certificate reference"
            value={external.certificate_ref}
            onChange={(v) => setExternal({ certificate_ref: v })}
            allowCreate={false}
            secretType={null}
          />
          </div>
          <div className="space-y-2" data-setting-path={at("external_llm.token_retrieval_url")}>
            <label htmlFor={`${id}-token-url`} className="text-sm font-medium">
              {tUi("Token retrieval URL")}
            </label>
            <Input
              id={`${id}-token-url`}
              type="url"
              value={external.token_retrieval_url || ""}
              onChange={(e) =>
                setExternal({ token_retrieval_url: e.target.value })
              }
            />
          </div>
        </>
      ) : (selected && modelOwner(selected) !== "telnyx") || isExternal || value.llm_api_key_ref ? (
        <div data-setting-path={isExternal ? at("external_llm.llm_api_key_ref") : at("llm_api_key_ref")}>
        <IntegrationSecretField
          value={isExternal ? external.llm_api_key_ref : value.llm_api_key_ref}
          onChange={(v) =>
            isExternal
              ? setExternal({ llm_api_key_ref: v })
              : onChange({ ...value, llm_api_key_ref: v })
          }
        />
        </div>
      ) : null}
      {isExternal ? (
        <div className="flex items-start justify-between gap-4 rounded-lg border p-4" data-setting-path={at("external_llm.forward_metadata")}>
          <div>
            <label htmlFor={`${id}-metadata`} className="text-sm font-medium">
              {tUi("Forward conversation metadata")}
            </label>
            <p className="mt-1 text-xs text-muted-foreground">
              {tUi(
                "Sends dynamic variables to this endpoint in extra_metadata, including caller and conversation context.",
              )}
            </p>
          </div>
          <Switch
            id={`${id}-metadata`}
            checked={external.forward_metadata === true}
            onCheckedChange={(checked) =>
              setExternal({ forward_metadata: checked })
            }
          />
        </div>
      ) : null}
    </fieldset>
  );
}

"use client";
import { useEffect, useState } from "react";
import { useUiText } from "@/components/i18n/use-ui-text";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { IconPlus, IconTrash } from "@tabler/icons-react";
import { assistantSchemas } from "@/lib/ai/assistant-contract.mjs";

const cards = assistantSchemas.PayToolParams.properties.valid_card_types.items.enum;
const cardLabels = { visa: "Visa", mastercard: "Mastercard", amex: "American Express", maestro: "Maestro", discover: "Discover", optima: "Optima", jcb: "JCB", "diners-club": "Diners Club", enroute: "EnRoute" };
export default function PaymentToolEditor({ value, onChange, onValidationChange }) {
  const t = useUiText();
  const config = value?.pay || {};
  const update = patch => onChange({ ...value, pay: { ...config, ...patch } });
  const [rows, setRows] = useState(() => Object.entries(config.connector_parameters || {}).map(([name, value]) => ({ name, text: typeof value === "string" ? value : JSON.stringify(value), structured: typeof value !== "string" })));
  const [error, setError] = useState("");
  useEffect(() => { onValidationChange?.(error); }, [error, onValidationChange]);
  function changeRows(next) {
    setRows(next);
    const result = {};
    try {
      for (const row of next) {
        if (!row.name.trim()) throw new Error("Enter a name for each connector parameter.");
        if (Object.hasOwn(result, row.name.trim())) throw new Error("Each connector parameter needs a different name.");
        let parsed = row.text;
        if (row.structured) {
          try { parsed = JSON.parse(row.text); } catch { throw new Error("Check the structured value for this connector parameter. It must be valid JSON."); }
        }
        Object.defineProperty(result, row.name.trim(), { value: parsed, enumerable: true });
      }
      setError(""); update({ connector_parameters: result });
    } catch (e) { setError(t(e.message)); }
  }
  return <div className="space-y-6">
    <p className="text-sm text-muted-foreground">{t("Collect card details securely using the caller's keypad. Call recording pauses automatically during payment collection.")}</p>
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <div className="space-y-2 sm:col-span-2"><Label htmlFor="payment-connector">{t("Payment connector")}</Label><Input id="payment-connector" value={config.connector_name || ""} placeholder={t("Name of your configured Telnyx payment connector")} onChange={e => update({ connector_name: e.target.value })} /><p className="text-xs text-muted-foreground">{t("Use an existing payment connector from your Telnyx account.")}</p></div>
      <div className="space-y-2"><Label htmlFor="payment-currency">{t("Currency")}</Label><Input id="payment-currency" value={config.currency ?? "USD"} placeholder="USD" onChange={e => update({ currency: e.target.value.toUpperCase() })} /></div>
      <div className="space-y-2"><Label htmlFor="payment-method">{t("Payment method")}</Label><Select value={config.payment_method || "credit-card"} onValueChange={payment_method => update({ payment_method })}><SelectTrigger id="payment-method" className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="credit-card">{t("Credit card")}</SelectItem><SelectItem value="ach-debit">{t("Bank account (ACH)")}</SelectItem>{config.payment_method && !["credit-card", "ach-debit"].includes(config.payment_method) && <SelectItem value={config.payment_method}>{config.payment_method}</SelectItem>}</SelectContent></Select></div>
    </div>
    <div className="space-y-2"><Label htmlFor="payment-description">{t("When to collect payment")}</Label><Textarea id="payment-description" rows={3} value={config.description || ""} placeholder={t("Describe when the assistant should request a payment.")} onChange={e => update({ description: e.target.value })} /></div>
    <section className="space-y-3 border-t pt-5"><h3 className="text-sm font-semibold">{t("Accepted cards")}</h3><p className="text-xs text-muted-foreground">{t("Leave all unchecked to use the connector's supported cards, or select the cards you want to accept.")}</p><div className="grid grid-cols-2 gap-3 sm:grid-cols-3">{cards.map(card => <label key={card} className="flex items-center gap-2 text-sm"><Checkbox checked={config.valid_card_types?.includes(card) || false} onCheckedChange={checked => { const next = checked ? [...(config.valid_card_types || []), card] : (config.valid_card_types || []).filter(v => v !== card); update({ valid_card_types: next.length ? next : undefined }); }} />{cardLabels[card]}</label>)}</div></section>
    <section className="space-y-4 border-t pt-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="text-sm font-semibold">{t("Connector parameters")}</h3><p className="mt-1 text-xs text-muted-foreground">{t("Optional details to pass to your payment processor.")}</p></div><Button type="button" variant="outline" size="sm" onClick={() => changeRows([...rows, { name: "", text: "", structured: false }])}><IconPlus className="size-4" />{t("Add parameter")}</Button></div>
      {rows.map((row, index) => <div key={index} className="space-y-2"><div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-end gap-3"><div className="space-y-2"><Label htmlFor={`pay-key-${index}`}>{t("Name")}</Label><Input id={`pay-key-${index}`} value={row.name} onChange={e => changeRows(rows.map((r, i) => i === index ? { ...r, name: e.target.value } : r))} /></div><div className="space-y-2"><Label htmlFor={`pay-value-${index}`}>{t("Value")}</Label><Input id={`pay-value-${index}`} value={row.text} placeholder="{{customer_ref}}" onChange={e => changeRows(rows.map((r, i) => i === index ? { ...r, text: e.target.value } : r))} /></div><Button type="button" variant="ghost" size="icon" aria-label={t("Remove parameter {value0}", { value0: index + 1 })} onClick={() => changeRows(rows.filter((_, i) => i !== index))}><IconTrash className="size-4 text-destructive" /></Button></div><label className="flex items-center gap-2 text-xs text-muted-foreground"><Checkbox checked={row.structured} onCheckedChange={checked => changeRows(rows.map((r, i) => i === index ? { ...r, structured: checked === true } : r))} />{t("Structured value (advanced)")}</label></div>)}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </section>
    <p className="text-xs text-muted-foreground">{t("In Calling settings, disable regular keypad detection so payment digits are handled securely by the payment tool.")}</p>
  </div>;
}

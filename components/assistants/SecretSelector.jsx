"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { IconKey } from "@tabler/icons-react";

export default function SecretSelector({ onSelect }) {
  const [secrets, setSecrets] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadSecrets() {
      try {
        const res = await fetch("/api/integration-secrets", {
          cache: "no-store",
        });
        const data = await res.json();
        if (res.ok && data?.ok) {
          const secretsList = (data.secrets || []).map((s) => ({
            id: s.identifier,
            name: s.identifier,
          }));
          setSecrets(secretsList);
        }
      } catch (err) {
        console.error("Failed to load secrets:", err);
      } finally {
        setLoading(false);
      }
    }
    loadSecrets();
  }, []);

  const handleSecretSelect = (secretName) => {
    if (secretName && onSelect) {
      const template = `{{#integration_secret}}${secretName}{{/integration_secret}}`;
      onSelect(template);
    }
  };

  if (loading) {
    return (
      <Button
        type="button"
        variant="outline"
        size="icon"
        disabled
        className="h-8 w-8 p-0"
      >
        <IconKey className="h-4 w-4" />
      </Button>
    );
  }

  if (secrets.length === 0) {
    return null;
  }

  return (
    <Select onValueChange={handleSecretSelect}>
      <SelectTrigger className="h-8 w-8 p-0 border-0 bg-transparent [&>svg]:hidden">
        <div className="h-8 w-8 p-0 flex items-center justify-center">
          <IconKey className="h-4 w-4 text-telnyx-green" />
        </div>
      </SelectTrigger>
      <SelectContent>
        {secrets.map((secret) => (
          <SelectItem key={secret.id} value={secret.name}>
            <div className="flex flex-col">
              <span className="font-mono text-sm">{secret.name}</span>
            </div>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

"use client";

export function InteractionDetail({ interaction }) {
  if (!interaction) {
    return (
      <div className="flex items-center justify-center flex-1 text-muted-foreground">
        <p>Select an interaction to view details</p>
      </div>
    );
  }

  return (
    <div className="p-4">
      <p className="text-sm text-muted-foreground">
        Interaction details panel - coming soon
      </p>
    </div>
  );
}


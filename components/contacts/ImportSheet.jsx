"use client";

import React from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetFooter,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { IconUpload, IconFileDownload, IconX } from "@tabler/icons-react";
import { notify } from "@/components/ToastNotify";
import { Card, CardContent } from "@/components/ui/card";

/**
 * Import sheet component for Contacts
 * @param {object} props
 * @param {boolean} props.open - Whether the sheet is open
 * @param {function} props.onOpenChange - Callback when sheet open state changes
 * @param {function} props.onImportComplete - Callback when import is complete
 */
export default function ContactImportSheet({
  open,
  onOpenChange,
  onImportComplete,
}) {
  const [file, setFile] = React.useState(null);
  const [dragActive, setDragActive] = React.useState(false);
  const [validating, setValidating] = React.useState(false);
  const [importing, setImporting] = React.useState(false);
  const [importProgress, setImportProgress] = React.useState(0);
  const [importComplete, setImportComplete] = React.useState(false);
  const [importResult, setImportResult] = React.useState(null);
  const [recordCount, setRecordCount] = React.useState(0);
  const [validationErrors, setValidationErrors] = React.useState([]);
  const fileInputRef = React.useRef(null);

  // Reset state when sheet closes
  React.useEffect(() => {
    if (!open) {
      setFile(null);
      setDragActive(false);
      setValidating(false);
      setImporting(false);
      setImportProgress(0);
      setImportComplete(false);
      setImportResult(null);
      setRecordCount(0);
      setValidationErrors([]);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  }, [open]);

  function handleDrag(e) {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  }

  function handleDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);

    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFile(e.dataTransfer.files[0]);
    }
  }

  function handleFileSelect(e) {
    if (e.target.files && e.target.files[0]) {
      handleFile(e.target.files[0]);
    }
  }

  function handleFile(selectedFile) {
    if (!selectedFile.name.endsWith(".csv")) {
      notify({
        title: "Invalid file type",
        description: "Please select a CSV file",
        variant: "error",
      });
      return;
    }
    setFile(selectedFile);
    setValidationErrors([]);
    setRecordCount(0);
    validateFile(selectedFile);
  }

  async function validateFile(fileToValidate) {
    setValidating(true);
    try {
      const formData = new FormData();
      formData.append("file", fileToValidate);

      const response = await fetch("/api/contacts/import/validate", {
        method: "POST",
        body: formData,
      });

      const data = await response.json();

      if (response.ok) {
        setRecordCount(data.recordCount || 0);
        setValidationErrors([]);
      } else {
        setValidationErrors(data.errors || [data.error || "Validation failed"]);
        setRecordCount(0);
        notify({
          title: "Validation failed",
          description: data.error || "Please check the file format",
          variant: "error",
        });
      }
    } catch (err) {
      setValidationErrors([String(err.message || err)]);
      setRecordCount(0);
      notify({
        title: "Validation error",
        description: String(err.message || err),
        variant: "error",
      });
    } finally {
      setValidating(false);
    }
  }

  async function downloadTemplate() {
    try {
      const response = await fetch("/api/contacts/import/template");
      if (!response.ok) throw new Error("Failed to download template");

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "contacts-template.csv";
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);

      notify({
        title: "Template downloaded",
        description: "You can now fill in your contacts and import the file",
        variant: "success",
      });
    } catch (err) {
      notify({
        title: "Download failed",
        description: String(err.message || err),
        variant: "error",
      });
    }
  }

  async function importContacts() {
    if (!file) {
      notify({
        title: "No file selected",
        description: "Please select a CSV file to import",
        variant: "error",
      });
      return;
    }

    if (recordCount === 0) {
      notify({
        title: "No valid records",
        description: "Please validate the file first",
        variant: "error",
      });
      return;
    }

    setImporting(true);
    setImportProgress(0);
    setImportComplete(false);
    setImportResult(null);

    // Simulate progress for better UX
    const progressInterval = setInterval(() => {
      setImportProgress((prev) => {
        if (prev >= 90) return prev;
        return prev + Math.random() * 10;
      });
    }, 200);

    try {
      const formData = new FormData();
      formData.append("file", file);

      const response = await fetch("/api/contacts/import", {
        method: "POST",
        body: formData,
      });

      clearInterval(progressInterval);
      setImportProgress(95);

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Import failed");
      }

      const data = await response.json();
      setImportProgress(100);
      setImportComplete(true);
      setImportResult(data);

      notify({
        title: "Import completed",
        description: `Successfully imported ${data.imported || 0} contact${
          data.imported !== 1 ? "s" : ""
        }${data.skipped > 0 ? ` (${data.skipped} skipped)` : ""}`,
        variant: "success",
      });

      // Refresh contact list but keep sheet open
      onImportComplete && onImportComplete();
    } catch (err) {
      clearInterval(progressInterval);
      setImportComplete(false);
      notify({
        title: "Import failed",
        description: String(err.message || err),
        variant: "error",
      });
      setImportProgress(0);
    } finally {
      setImporting(false);
    }
  }

  function removeFile() {
    setFile(null);
    setRecordCount(0);
    setValidationErrors([]);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-xl overflow-hidden flex flex-col p-0"
      >
        <SheetHeader className="px-6 py-4 border-b">
          <SheetTitle className="text-xl font-bold text-telnyx-green flex items-center gap-2">
            <IconUpload className="size-5" />
            Import Contacts
          </SheetTitle>
        </SheetHeader>

        {/* Scrollable Content Section */}
        <div className="flex-1 overflow-y-auto">
          <Card className="mx-5 my-4">
            <CardContent className="p-6 space-y-6">
              {/* Template Download Section */}
              <div>
                <h3 className="text-sm font-semibold text-muted-foreground mb-3">
                  Step 1: Download Template
                </h3>
                <p className="text-sm text-muted-foreground mb-4">
                  Download the CSV template with sample data. Fill in your
                  contacts and upload the file.
                </p>
                <Button
                  variant="outline"
                  onClick={downloadTemplate}
                  className="w-full"
                >
                  <IconFileDownload className="size-4 mr-2" />
                  Download CSV Template
                </Button>
              </div>

              <div className="border-t" />

              {/* File Upload Section */}
              <div>
                <h3 className="text-sm font-semibold text-muted-foreground mb-3">
                  Step 2: Upload CSV File
                </h3>
                {!file ? (
                  <div
                    className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
                      dragActive
                        ? "border-telnyx-green bg-telnyx-green/5"
                        : "border-muted-foreground/25 hover:border-muted-foreground/50"
                    }`}
                    onDragEnter={handleDrag}
                    onDragLeave={handleDrag}
                    onDragOver={handleDrag}
                    onDrop={handleDrop}
                  >
                    <IconUpload className="size-12 mx-auto mb-4 text-muted-foreground" />
                    <p className="text-sm font-medium mb-2">
                      Drag & drop your CSV file here
                    </p>
                    <p className="text-xs text-muted-foreground mb-4">or</p>
                    <Button
                      variant="outline"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      Select File
                    </Button>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".csv"
                      onChange={handleFileSelect}
                      className="hidden"
                    />
                  </div>
                ) : (
                  <div className="border rounded-lg p-4 bg-muted/50">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="size-10 rounded bg-telnyx-green/10 flex items-center justify-center">
                          <IconUpload className="size-5 text-telnyx-green" />
                        </div>
                        <div>
                          <p className="text-sm font-medium">{file.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {(file.size / 1024).toFixed(2)} KB
                          </p>
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={removeFile}
                        className="size-8"
                      >
                        <IconX className="size-4" />
                      </Button>
                    </div>
                  </div>
                )}
              </div>

              {/* Validation Status */}
              {file && (
                <>
                  <div className="border-t" />
                  <div>
                    <h3 className="text-sm font-semibold text-muted-foreground mb-3">
                      Step 3: Validation
                    </h3>
                    {validating ? (
                      <div className="text-center py-4">
                        <p className="text-sm text-muted-foreground">
                          Validating file...
                        </p>
                      </div>
                    ) : validationErrors.length > 0 ? (
                      <div className="border rounded-lg p-4 bg-destructive/10 border-destructive/20">
                        <p className="text-sm font-medium text-destructive mb-2">
                          Validation Errors:
                        </p>
                        <ul className="text-xs text-destructive space-y-1 list-disc list-inside">
                          {validationErrors.map((error, idx) => (
                            <li key={idx}>{error}</li>
                          ))}
                        </ul>
                      </div>
                    ) : recordCount > 0 ? (
                      <div className="border rounded-lg p-4 bg-green-50 dark:bg-green-950/20 border-green-200 dark:border-green-800">
                        <p className="text-sm font-medium text-green-700 dark:text-green-400">
                          ✓ File validated successfully
                        </p>
                        <p className="text-xs text-green-600 dark:text-green-500 mt-1">
                          {recordCount} record{recordCount !== 1 ? "s" : ""}{" "}
                          ready to import
                        </p>
                      </div>
                    ) : null}
                  </div>
                </>
              )}

              {/* Import Progress */}
              {(importing || importComplete) && (
                <>
                  <div className="border-t" />
                  <div>
                    <h3 className="text-sm font-semibold text-muted-foreground mb-3">
                      {importComplete
                        ? "Import Completed"
                        : "Importing Contacts"}
                    </h3>
                    <div className="space-y-2">
                      <Progress
                        value={importProgress}
                        className="h-2 [&>div]:bg-orange-500"
                      />
                      <p className="text-xs text-muted-foreground text-center">
                        {importComplete
                          ? "100% complete"
                          : `${Math.round(importProgress)}% complete`}
                      </p>
                      {importComplete && importResult && (
                        <div className="mt-3 border rounded-lg p-3 bg-green-50 dark:bg-green-950/20 border-green-200 dark:border-green-800">
                          <p className="text-sm font-medium text-green-700 dark:text-green-400">
                            ✓ Import successful
                          </p>
                          <p className="text-xs text-green-600 dark:text-green-500 mt-1">
                            {importResult.imported || 0} contact
                            {importResult.imported !== 1 ? "s" : ""} imported
                            {importResult.skipped > 0
                              ? `, ${importResult.skipped} skipped`
                              : ""}
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Fixed Footer */}
        <SheetFooter className="px-6 py-4 border-t flex flex-row justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={importing}
          >
            Cancel
          </Button>
          <Button
            onClick={importContacts}
            disabled={
              importing ||
              !file ||
              recordCount === 0 ||
              validating ||
              importComplete
            }
          >
            {importing
              ? "Importing..."
              : importComplete
              ? "Import Complete"
              : "Import Contacts"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetFooter,
} from "@/components/ui/sheet";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { notify } from "@/components/ToastNotify";
import { IconUpload, IconFileMusic, IconX } from "@tabler/icons-react";

export default function MediaUploadSheet({ open, onOpenChange, onUpload }) {
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [selectedFile, setSelectedFile] = useState(null);
  const [mediaName, setMediaName] = useState("");
  const [checkingUniqueness, setCheckingUniqueness] = useState(false);
  const fileInputRef = useRef(null);

  useEffect(() => {
    if (!open) {
      setSelectedFile(null);
      setMediaName("");
      setDragOver(false);
      setUploading(false);
      setCheckingUniqueness(false);
    }
  }, [open]);

  function validateFile(file) {
    if (!file) return { valid: false, error: "No file selected" };

    // Check file type
    const allowedTypes = [
      "audio/mpeg",
      "audio/mp3",
      "audio/wav",
      "audio/x-wav",
      "audio/wave",
    ];
    const fileType = file.type || "";

    // Check file extension
    const fileName = file.name || "";
    const fileExtension = fileName.split(".").pop()?.toLowerCase();
    const isValidExtension = ["mp3", "wav"].includes(fileExtension);

    if (
      !allowedTypes.some((type) => fileType.includes(type)) &&
      !isValidExtension
    ) {
      return {
        valid: false,
        error: "Only MP3 and WAV files are allowed",
      };
    }

    // Check file size (max 20 MB)
    const maxSize = 20 * 1024 * 1024; // 20 MB
    if (file.size > maxSize) {
      return {
        valid: false,
        error: "File size must be less than 20 MB",
      };
    }

    return { valid: true };
  }

  function validateMediaName(name) {
    if (!name || name.trim().length === 0) {
      return { valid: false, error: "Media name is required" };
    }

    const trimmed = name.trim();

    // Media name should be alphanumeric with dashes, underscores, and dots
    // Based on Telnyx API requirements
    const validPattern = /^[a-zA-Z0-9._-]+$/;
    if (!validPattern.test(trimmed)) {
      return {
        valid: false,
        error:
          "Media name can only contain letters, numbers, dots, dashes, and underscores",
      };
    }

    if (trimmed.length < 1 || trimmed.length > 255) {
      return {
        valid: false,
        error: "Media name must be between 1 and 255 characters",
      };
    }

    return { valid: true };
  }

  async function checkMediaNameUniqueness(name) {
    if (!name || name.trim().length === 0) return { unique: false };

    try {
      const response = await fetch(
        `/api/admin/media-library/${encodeURIComponent(name.trim())}`
      );

      // If we get a 404, the name is unique (doesn't exist)
      if (response.status === 404) {
        return { unique: true };
      }

      // If we get a 200, the name already exists
      if (response.ok) {
        return { unique: false };
      }

      // For other errors, assume it might be unique (let the upload handle it)
      return { unique: true };
    } catch (err) {
      console.error("[MediaUploadSheet] Error checking uniqueness:", err);
      // On error, assume it might be unique (let the upload handle it)
      return { unique: true };
    }
  }

  async function handleUpload() {
    if (!selectedFile || uploading) return;

    const fileValidation = validateFile(selectedFile);
    if (!fileValidation.valid) {
      notify({
        title: "Invalid file",
        description: fileValidation.error,
        variant: "error",
      });
      return;
    }

    const nameValidation = validateMediaName(mediaName);
    if (!nameValidation.valid) {
      notify({
        title: "Invalid media name",
        description: nameValidation.error,
        variant: "error",
      });
      return;
    }

    // Check uniqueness
    setCheckingUniqueness(true);
    const uniquenessCheck = await checkMediaNameUniqueness(mediaName);
    setCheckingUniqueness(false);

    if (!uniquenessCheck.unique) {
      notify({
        title: "Media name already exists",
        description:
          "Please choose a different name. This media name is already in use.",
        variant: "error",
      });
      return;
    }

    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", selectedFile);
      formData.append("media_name", mediaName.trim());

      const response = await fetch("/api/admin/media-library", {
        method: "POST",
        body: formData,
      });

      const data = await response.json();

      if (!response.ok) {
        // Check if error is about duplicate media name (409 Conflict or error message)
        const errorMsg = data?.error || "Failed to upload file";
        if (
          response.status === 409 ||
          errorMsg.toLowerCase().includes("already exists") ||
          errorMsg.toLowerCase().includes("duplicate") ||
          errorMsg.toLowerCase().includes("conflict") ||
          errorMsg.toLowerCase().includes("taken")
        ) {
          notify({
            title: "Media name already exists",
            description:
              "This media name is already in use. Please choose a different name.",
            variant: "error",
          });
          return;
        }
        throw new Error(errorMsg);
      }

      notify({
        title: "Upload successful",
        description: "Media file uploaded successfully",
        variant: "success",
      });

      setSelectedFile(null);
      setMediaName("");
      onUpload?.(data.data);
      onOpenChange?.(false);
    } catch (err) {
      notify({
        title: "Upload failed",
        description: String(err.message || err),
        variant: "error",
      });
    } finally {
      setUploading(false);
    }
  }

  function generateMediaNameFromFileName(fileName) {
    if (!fileName) return "";

    // Remove extension
    const nameWithoutExt = fileName.replace(/\.[^/.]+$/, "");

    // Convert to lowercase and replace spaces/special chars with dashes
    const cleaned = nameWithoutExt
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");

    return cleaned;
  }

  function handleFileSelect(files) {
    if (!files || files.length === 0) return;

    const file = files[0];
    const validation = validateFile(file);

    if (!validation.valid) {
      notify({
        title: "Invalid file",
        description: validation.error,
        variant: "error",
      });
      return;
    }

    setSelectedFile(file);

    // Auto-generate media name from file name if not already set
    if (!mediaName || mediaName.trim().length === 0) {
      const suggestedName = generateMediaNameFromFileName(file.name);
      if (suggestedName) {
        setMediaName(suggestedName);
      }
    }
  }

  function handleFileInputChange(e) {
    handleFileSelect(Array.from(e.target.files || []));
  }

  function handleDrop(e) {
    e.preventDefault();
    setDragOver(false);
    handleFileSelect(Array.from(e.dataTransfer.files || []));
  }

  function handleDragOver(e) {
    e.preventDefault();
    setDragOver(true);
  }

  function handleDragLeave(e) {
    e.preventDefault();
    setDragOver(false);
  }

  function formatFileSize(bytes) {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-xl overflow-hidden flex flex-col p-0"
      >
        <SheetHeader className="px-6 py-4 border-b">
          <SheetTitle className="text-xl font-bold text-telnyx-green flex items-center gap-2">
            <IconFileMusic className="size-5" />
            Upload Media File
          </SheetTitle>
        </SheetHeader>

        <div className="flex-1 min-h-0 overflow-hidden flex flex-col px-5 py-4">
          <Card className="flex-1 flex flex-col overflow-hidden">
            <CardContent className="p-6 flex-1 flex flex-col min-h-0">
              <div className="space-y-4">
                <div className="text-sm text-muted-foreground">
                  Upload MP3 or WAV audio files. Maximum file size is 20 MB.
                  Files will never expire.
                </div>

                {/* Media name input */}
                <div className="space-y-2">
                  <Label htmlFor="media-name">
                    Media Name <span className="text-red-500">*</span>
                  </Label>
                  <Input
                    id="media-name"
                    value={mediaName}
                    onChange={(e) => setMediaName(e.target.value)}
                    placeholder="e.g., welcome-message, hold-music"
                    disabled={uploading || checkingUniqueness}
                    className="w-full"
                  />
                  <div className="text-xs text-muted-foreground">
                    Provide a descriptive name for this media file. Only
                    letters, numbers, dots, dashes, and underscores are
                    allowed. Must be unique.
                  </div>
                </div>

                {/* Drag and drop area */}
                <div
                  className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
                    dragOver
                      ? "border-telnyx-green bg-telnyx-green/5"
                      : "border-muted-foreground/25 hover:border-muted-foreground/50"
                  }`}
                  onDrop={handleDrop}
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".mp3,.wav,audio/mpeg,audio/wav"
                    onChange={handleFileInputChange}
                    className="hidden"
                  />

                  {selectedFile ? (
                    <div className="space-y-4">
                      <div className="flex items-center justify-center">
                        <IconFileMusic className="size-12 text-telnyx-green" />
                      </div>
                      <div className="space-y-2">
                        <div className="font-medium">{selectedFile.name}</div>
                        <div className="text-sm text-muted-foreground">
                          {formatFileSize(selectedFile.size)}
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setSelectedFile(null)}
                          className="mt-2"
                        >
                          <IconX className="size-4 mr-2" />
                          Remove
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      <div className="flex items-center justify-center">
                        <IconUpload className="size-12 text-muted-foreground" />
                      </div>
                      <div className="space-y-2">
                        <div className="font-medium">
                          Drag and drop a file here
                        </div>
                        <div className="text-sm text-muted-foreground">
                          or click to browse
                        </div>
                        <Button
                          variant="outline"
                          onClick={() => fileInputRef.current?.click()}
                        >
                          Select File
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        <SheetFooter className="px-6 py-4 border-t flex flex-row justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange?.(false)}
            disabled={uploading}
          >
            Cancel
          </Button>
          <Button
            onClick={handleUpload}
            disabled={
              !selectedFile ||
              !mediaName.trim() ||
              uploading ||
              checkingUniqueness
            }
            className="bg-telnyx-green hover:bg-telnyx-green/90"
          >
            {checkingUniqueness
              ? "Checking..."
              : uploading
                ? "Uploading..."
                : "Upload"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}


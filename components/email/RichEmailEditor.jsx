"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  IconAlignCenter,
  IconAlignJustified,
  IconAlignLeft,
  IconAlignRight,
  IconArrowBackUp,
  IconArrowForwardUp,
  IconBlockquote,
  IconBold,
  IconBraces,
  IconClearFormatting,
  IconCode,
  IconH1,
  IconH2,
  IconHighlight,
  IconIndentDecrease,
  IconIndentIncrease,
  IconItalic,
  IconLink,
  IconList,
  IconListNumbers,
  IconMinus,
  IconPhoto,
  IconStrikethrough,
  IconUnderline,
} from "@tabler/icons-react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { sanitizeRichTextHtml } from "@/components/forms/rich-text-html";

const FONT_FAMILIES = [
  ["Arial", "Arial, sans-serif"],
  ["Georgia", "Georgia, serif"],
  ["Tahoma", "Tahoma, sans-serif"],
  ["Times New Roman", '"Times New Roman", serif'],
  ["Trebuchet", '"Trebuchet MS", sans-serif'],
  ["Verdana", "Verdana, sans-serif"],
];

const FONT_SIZES = [
  ["Small", "2"],
  ["Normal", "3"],
  ["Large", "4"],
  ["Extra large", "5"],
];

function ToolbarButton({ label, icon: Icon, active = false, onAction }) {
  return (
    <Button
      type="button"
      variant={active ? "secondary" : "ghost"}
      size="icon"
      className="size-8 shrink-0 rounded-md"
      aria-label={label}
      title={label}
      onMouseDown={(event) => {
        event.preventDefault();
        onAction();
      }}
    >
      <Icon className="size-4" />
    </Button>
  );
}

function ToolbarDivider() {
  return <span className="mx-1 h-5 w-px shrink-0 bg-border" aria-hidden="true" />;
}

export function RichEmailEditor({
  value,
  onChange,
  onTextChange,
  placeholder = "Write your message…",
  minHeight = 180,
  className,
  disabled = false,
  sanitizeHtml = sanitizeRichTextHtml,
  serializeHtml = value => value,
  toolbarExtra,
}) {
  const editorRef = useRef(null);
  // Start with a sentinel so externally supplied HTML is written into the
  // contentEditable element on its first mount (drafts and AI-generated mail).
  const lastValueRef = useRef(null);
  const [sourceMode, setSourceMode] = useState(false);
  const [blockType, setBlockType] = useState("p");
  const [fontFamily, setFontFamily] = useState("Arial");
  const [fontSize, setFontSize] = useState("3");

  useEffect(() => {
    const next = value || "";
    if (!sourceMode && editorRef.current && next !== lastValueRef.current) {
      editorRef.current.innerHTML = sanitizeHtml(next);
      lastValueRef.current = next;
    }
  }, [sourceMode, value, sanitizeHtml]);

  const publish = useCallback(() => {
    if (!editorRef.current) return;
    const html = serializeHtml(editorRef.current.innerHTML);
    lastValueRef.current = html;
    onChange?.(html);
    onTextChange?.(editorRef.current.innerText || "");
  }, [onChange, onTextChange, serializeHtml]);

  const command = useCallback(
    (name, commandValue = null) => {
      if (sourceMode || disabled) return;
      editorRef.current?.focus();
      document.execCommand(name, false, commandValue);
      publish();
    },
    [publish, sourceMode, disabled]
  );

  const insertLink = useCallback(() => {
    const url = window.prompt("Link URL", "https://");
    if (!url) return;
    if (/^https?:\/\//i.test(url)) command("createLink", url);
  }, [command]);

  const insertImage = useCallback(() => {
    const url = window.prompt("Image URL", "https://");
    if (!url) return;
    if (/^https?:\/\//i.test(url)) command("insertImage", url);
  }, [command]);

  const toggleSource = useCallback(() => {
    if (sourceMode) {
      // The visual editor is unmounted while the source textarea is visible,
      // so editorRef.current cannot be updated here. Reset the synchronization
      // sentinel and let the effect hydrate the newly mounted editor instead.
      lastValueRef.current = null;
    }
    setSourceMode((current) => !current);
  }, [sourceMode]);

  return (
    <div
      inert={disabled ? true : undefined}
      className={cn(
        "flex flex-col overflow-hidden rounded-xl border bg-background shadow-sm focus-within:ring-2 focus-within:ring-ring/30",
        className
      )}
    >
      <div className="flex flex-wrap items-center gap-0.5 border-b bg-muted/30 px-2 py-1.5">
        <Select
          value={fontFamily}
          onValueChange={(next) => {
            setFontFamily(next);
            const family = FONT_FAMILIES.find(([name]) => name === next)?.[1];
            command("fontName", family);
          }}
        >
          <SelectTrigger className="mr-1 h-8 w-[126px] border-0 bg-transparent text-xs shadow-none">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FONT_FAMILIES.map(([name]) => (
              <SelectItem key={name} value={name}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={fontSize}
          onValueChange={(next) => {
            setFontSize(next);
            command("fontSize", next);
          }}
        >
          <SelectTrigger className="mr-1 h-8 w-[90px] border-0 bg-transparent text-xs shadow-none">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FONT_SIZES.map(([name, size]) => (
              <SelectItem key={size} value={size}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <ToolbarDivider />
        <ToolbarButton
          label="Undo"
          icon={IconArrowBackUp}
          onAction={() => command("undo")}
        />
        <ToolbarButton
          label="Redo"
          icon={IconArrowForwardUp}
          onAction={() => command("redo")}
        />
        <ToolbarDivider />
        <ToolbarButton label="Bold" icon={IconBold} onAction={() => command("bold")} />
        <ToolbarButton label="Italic" icon={IconItalic} onAction={() => command("italic")} />
        <ToolbarButton
          label="Underline"
          icon={IconUnderline}
          onAction={() => command("underline")}
        />
        <ToolbarButton
          label="Strikethrough"
          icon={IconStrikethrough}
          onAction={() => command("strikeThrough")}
        />
        <label
          className="relative flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md hover:bg-accent"
          title="Text color"
        >
          <IconHighlight className="size-4" />
          <input
            type="color"
            className="absolute inset-0 cursor-pointer opacity-0"
            onChange={(event) => command("foreColor", event.target.value)}
          />
          <span className="absolute bottom-1 h-0.5 w-4 rounded-full bg-foreground" />
        </label>
        <label
          className="relative flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md hover:bg-accent"
          title="Highlight color"
        >
          <IconHighlight className="size-4 fill-amber-300/40" />
          <input
            type="color"
            defaultValue="#fff2a8"
            className="absolute inset-0 cursor-pointer opacity-0"
            onChange={(event) => command("hiliteColor", event.target.value)}
          />
        </label>
        <ToolbarDivider />
        <ToolbarButton
          label="Align left"
          icon={IconAlignLeft}
          onAction={() => command("justifyLeft")}
        />
        <ToolbarButton
          label="Align center"
          icon={IconAlignCenter}
          onAction={() => command("justifyCenter")}
        />
        <ToolbarButton
          label="Align right"
          icon={IconAlignRight}
          onAction={() => command("justifyRight")}
        />
        <ToolbarButton
          label="Justify"
          icon={IconAlignJustified}
          onAction={() => command("justifyFull")}
        />
        <ToolbarDivider />
        <ToolbarButton
          label="Bulleted list"
          icon={IconList}
          onAction={() => command("insertUnorderedList")}
        />
        <ToolbarButton
          label="Numbered list"
          icon={IconListNumbers}
          onAction={() => command("insertOrderedList")}
        />
        <ToolbarButton
          label="Decrease indent"
          icon={IconIndentDecrease}
          onAction={() => command("outdent")}
        />
        <ToolbarButton
          label="Increase indent"
          icon={IconIndentIncrease}
          onAction={() => command("indent")}
        />
        <ToolbarDivider />
        <ToolbarButton
          label="Heading 1"
          icon={IconH1}
          onAction={() => {
            setBlockType("h1");
            command("formatBlock", "h1");
          }}
        />
        <ToolbarButton
          label="Heading 2"
          icon={IconH2}
          onAction={() => {
            setBlockType("h2");
            command("formatBlock", "h2");
          }}
        />
        <ToolbarButton
          label="Quote"
          icon={IconBlockquote}
          onAction={() => {
            setBlockType("blockquote");
            command("formatBlock", "blockquote");
          }}
        />
        <ToolbarButton label="Insert link" icon={IconLink} onAction={insertLink} />
        <ToolbarButton label="Insert image" icon={IconPhoto} onAction={insertImage} />
        <ToolbarButton
          label="Horizontal rule"
          icon={IconMinus}
          onAction={() => command("insertHorizontalRule")}
        />
        <ToolbarButton
          label="Inline code"
          icon={IconCode}
          onAction={() => {
            setBlockType("pre");
            command("formatBlock", "pre");
          }}
        />
        <ToolbarButton
          label="Clear formatting"
          icon={IconClearFormatting}
          onAction={() => command("removeFormat")}
        />
        <ToolbarDivider />
        <ToolbarButton
          label={sourceMode ? "Visual editor" : "Edit HTML source"}
          icon={sourceMode ? IconBraces : IconCode}
          active={sourceMode}
          onAction={toggleSource}
        />
      </div>

      {toolbarExtra && <div className="shrink-0 border-b bg-muted/10 px-2 py-1.5">{toolbarExtra}</div>}
      {sourceMode ? (
        <Textarea
          value={value || ""}
          onChange={(event) => {
            onChange?.(event.target.value);
          }}
          spellCheck={false}
          className="flex-1 resize-none rounded-none border-0 font-mono text-xs shadow-none focus-visible:ring-0"
          style={{ minHeight }}
          aria-label="HTML source"
        />
      ) : (
        <div
          ref={editorRef}
          contentEditable={!disabled}
          aria-label="Email reply body"
          onPaste={(event) => { event.preventDefault(); command("insertText", event.clipboardData.getData("text/plain")); }}
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          data-placeholder={placeholder}
          onInput={publish}
          onBlur={publish}
          className={cn(
            "flex-1 overflow-y-auto px-5 py-4 text-[15px] leading-7 outline-none",
            "empty:before:pointer-events-none empty:before:text-muted-foreground empty:before:content-[attr(data-placeholder)]",
            "[&_a]:text-sky-600 [&_a]:underline [&_blockquote]:border-l-4 [&_blockquote]:border-emerald-400 [&_blockquote]:pl-4",
            "[&_h1]:my-3 [&_h1]:text-3xl [&_h1]:font-bold [&_h2]:my-3 [&_h2]:text-2xl [&_h2]:font-semibold",
            "[&_img]:my-3 [&_img]:max-w-full [&_ol]:ml-6 [&_ol]:list-decimal [&_pre]:rounded-lg [&_pre]:bg-muted [&_pre]:p-3 [&_ul]:ml-6 [&_ul]:list-disc"
          )}
          style={{ minHeight }}
        />
      )}
      <div className="flex items-center justify-between border-t bg-muted/20 px-3 py-1.5 text-[11px] text-muted-foreground">
        <span>Rich HTML email</span>
        <span>{blockType === "p" ? "Paragraph" : blockType.toUpperCase()}</span>
      </div>
    </div>
  );
}

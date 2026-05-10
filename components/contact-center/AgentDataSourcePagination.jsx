"use client";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const PAGE_SIZE_OPTIONS = [10, 25, 50];

export function AgentDataSourcePagination({
  page,
  pageSize,
  totalCount,
  loading = false,
  onPageChange,
  onPageSizeChange,
}) {
  const totalPages = Math.max(1, Math.ceil((totalCount || 0) / pageSize));
  const start = totalCount === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(totalCount, page * pageSize);

  return (
    <div className="flex shrink-0 items-center justify-between gap-3 border-t bg-muted/30 px-4 py-2 text-xs text-muted-foreground">
      <div className="min-w-0 truncate">
        {totalCount === 0 ? "No results" : `${start}-${end} of ${totalCount}`}
      </div>
      <div className="flex items-center gap-2">
        <span className="hidden sm:inline">Rows</span>
        <Select
          value={String(pageSize)}
          onValueChange={(value) => onPageSizeChange?.(Number(value))}
        >
          <SelectTrigger className="h-8 w-[76px] bg-background">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PAGE_SIZE_OPTIONS.map((option) => (
              <SelectItem key={option} value={String(option)}>
                {option}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 px-2"
          onClick={() => onPageChange?.(Math.max(1, page - 1))}
          disabled={loading || page <= 1}
        >
          Prev
        </Button>
        <span className="whitespace-nowrap">
          {page} / {totalPages}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 px-2"
          onClick={() => onPageChange?.(Math.min(totalPages, page + 1))}
          disabled={loading || page >= totalPages}
        >
          Next
        </Button>
      </div>
    </div>
  );
}

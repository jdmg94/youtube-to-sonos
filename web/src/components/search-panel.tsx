"use client";

import { useEffect, useRef } from 'react';
import { Clock, Infinity as InfinityIcon, Loader2, Play, Plus, Search } from "lucide-react";
import { toast } from "sonner";

import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { Device } from "@/lib/api/types";
import { useErrorToast } from "@/lib/hooks/use-error-toast";
import { useSearch } from "@/lib/hooks/use-search";
import { formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface SearchPanelProps {
  device: Device | null;
  onNavigateToQueue: () => void;
}

export function SearchPanel({ device, onNavigateToQueue }: SearchPanelProps) {
  const search = useSearch(device?.ip ?? null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Task 3's useSearch uses Error, not ApiError
  useErrorToast(search.searchError as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Task 3's useSearch uses Error, not ApiError
  useErrorToast(search.castError as any);

  async function handleCast(videoId: string, mode: 'now' | 'next') {
    const result = await search.cast(videoId, mode);
    if (result) {
      if (result.status === 'playing') {
        toast.success(`Playing: ${result.title || 'Unknown track'}`);
      } else if (result.queued_next) {
        toast.success(`Queued: ${result.title || 'Unknown track'}`);
      }
      onNavigateToQueue();
    }
  }

  return (
    <div className="flex flex-col">
      <h2 className="mb-6 flex items-center gap-3 font-heading text-xl font-semibold">
        <Search aria-hidden className="size-5 text-brand" />
        Search
      </h2>

      <form
        className="mb-6 flex gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          search.search();
        }}
      >
        <label className="sr-only" htmlFor="search-query">
          Search YouTube
        </label>
        <Input
          ref={inputRef}
          id="search-query"
          type="text"
          value={search.query}
          onChange={(event) => search.setQuery(event.target.value)}
          placeholder="Search YouTube (e.g. 'never gonna give you up')"
          autoComplete="off"
          spellCheck={false}
          className="h-auto grow rounded-[14px] border-border bg-white/[0.05] px-5 py-4 text-base transition-all duration-300 focus-visible:border-brand focus-visible:bg-white/[0.08] focus-visible:shadow-[0_0_15px_rgba(255,0,85,0.15)] focus-visible:ring-0 md:text-base"
        />
        <button
          type="submit"
          disabled={!search.query.trim()}
          className={cn(
            "flex shrink-0 cursor-pointer items-center gap-2 rounded-[14px] bg-gradient-to-br from-brand to-brand-strong px-7 py-4 font-semibold text-white",
            "transition-all duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] hover:-translate-y-0.5 hover:shadow-[0_6px_20px_rgba(255,0,85,0.4)]",
            "disabled:pointer-events-none disabled:opacity-50",
          )}
        >
          {search.searching ? (
            <Loader2 aria-hidden className="size-4 animate-spin" />
          ) : (
            <Search aria-hidden className="size-4" />
          )}
          Search
        </button>
      </form>

      <label className="mb-5 flex w-fit cursor-pointer select-none items-center gap-[0.6rem] text-[0.85rem] text-muted-foreground">
        <Switch
          checked={search.autoplay}
          onCheckedChange={search.setAutoplay}
          className={cn(
            "h-[22px] w-[38px] px-[3px]",
            "data-checked:border-gold/40 data-checked:bg-gold/25",
            "data-unchecked:border-border data-unchecked:bg-white/[0.12]",
            "[&_[data-slot=switch-thumb]]:size-4 [&_[data-slot=switch-thumb]]:bg-muted-foreground",
            "data-checked:[&_[data-slot=switch-thumb]]:translate-x-4 data-checked:[&_[data-slot=switch-thumb]]:bg-gold",
          )}
        />
        <span className="flex items-center gap-[0.4rem]">
          <InfinityIcon aria-hidden className="size-4 text-gold" />
          Autoplay similar tracks
        </span>
      </label>

      {search.searching && <LoadingState />}

      {!search.searching && search.results.length > 0 && (
        <ResultsList
          results={search.results}
          casting={search.casting}
          disabled={!device}
          onCast={handleCast}
        />
      )}

      {!search.searching && search.results.length === 0 && search.query && (
        <EmptyState query={search.query} />
      )}
    </div>
  );
}

function LoadingState() {
  return (
    <div className="flex flex-col gap-4">
      {Array.from({ length: 5 }).map((_, i) => (
        <div
          key={i}
          className="flex gap-4 rounded-[20px] border border-border bg-card p-4"
        >
          <div className="skeleton aspect-video w-[120px] shrink-0 rounded-lg" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="skeleton h-5 w-4/5" />
            <div className="skeleton h-4 w-1/2" />
            <div className="skeleton h-4 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState({ query }: { query: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-[20px] border border-border bg-card p-12 text-center">
      <Search aria-hidden className="size-12 text-muted-foreground/50" />
      <div className="flex flex-col gap-2">
        <p className="text-lg font-semibold">No results for &ldquo;{query}&rdquo;</p>
        <p className="text-sm text-muted-foreground">Try a different search term</p>
      </div>
    </div>
  );
}

function ResultsList({
  results,
  casting,
  disabled,
  onCast,
}: {
  results: Array<{
    id: string;
    title: string | null;
    uploader: string | null;
    thumbnail: string | null;
    duration: number | null;
  }>;
  casting: string | null;
  disabled: boolean;
  onCast: (id: string, mode: 'now' | 'next') => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      {results.map((result) => (
        <ResultCard
          key={result.id}
          result={result}
          busy={casting === result.id}
          disabled={disabled || casting !== null}
          onCast={onCast}
        />
      ))}
    </div>
  );
}

function ResultCard({
  result,
  busy,
  disabled,
  onCast,
}: {
  result: {
    id: string;
    title: string | null;
    uploader: string | null;
    thumbnail: string | null;
    duration: number | null;
  };
  busy: boolean;
  disabled: boolean;
  onCast: (id: string, mode: 'now' | 'next') => void;
}) {
  return (
    <div className="flex flex-col gap-4 rounded-[20px] border border-border bg-card p-4 transition-all duration-300 hover:border-brand/30 min-[601px]:flex-row">
      <div className="relative aspect-video w-full shrink-0 overflow-hidden rounded-xl border border-border shadow-[0_4px_12px_rgba(0,0,0,0.3)] min-[601px]:w-[120px]">
        {result.thumbnail ? (
          // eslint-disable-next-line @next/next/no-img-element -- YouTube CDN thumbnails, not optimizable
          <img
            src={result.thumbnail}
            alt=""
            className="size-full object-cover"
          />
        ) : (
          <div className="flex size-full items-center justify-center bg-white/[0.04]">
            <Play aria-hidden className="size-6 text-muted-foreground" />
          </div>
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h3 className="line-clamp-2 font-heading text-base font-semibold leading-[1.4]">
            {result.title || 'Unknown title'}
          </h3>
          <p className="text-sm text-muted-foreground">
            {result.uploader || 'Unknown artist'}
          </p>
        </div>

        {result.duration !== null && (
          <div className="flex items-center gap-1 self-start rounded-md bg-white/[0.08] px-2 py-1 text-xs">
            <Clock aria-hidden className="size-3" />
            {formatDuration(result.duration)}
          </div>
        )}

        <div className="flex flex-col gap-2 min-[601px]:flex-row">
          <button
            type="button"
            onClick={() => onCast(result.id, 'now')}
            disabled={disabled}
            title={disabled && !busy ? "Select a speaker first" : "Play now"}
            className={cn(
              "flex grow-[2] cursor-pointer items-center justify-center gap-2 rounded-[14px] px-4 py-2.5 text-sm font-semibold",
              "bg-gradient-to-br from-gold to-[#b29124] text-[#1a1408] shadow-[0_4px_15px_rgba(212,175,55,0.25)]",
              "transition-all duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] hover:-translate-y-0.5 hover:shadow-[0_6px_20px_rgba(212,175,55,0.4)]",
              "disabled:pointer-events-none disabled:opacity-50",
            )}
          >
            {busy ? (
              <Loader2 aria-hidden className="size-4 animate-spin" />
            ) : (
              <Play aria-hidden className="size-4" />
            )}
            {busy ? 'Casting…' : 'Play now'}
          </button>

          <button
            type="button"
            onClick={() => onCast(result.id, 'next')}
            disabled={disabled}
            title={disabled && !busy ? "Select a speaker first" : "Play next"}
            className={cn(
              "flex grow cursor-pointer items-center justify-center gap-2 rounded-[14px] border border-border bg-white/[0.08] px-4 py-2.5 text-sm font-semibold",
              "transition-all duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] hover:-translate-y-0.5 hover:bg-white/[0.15]",
              "disabled:pointer-events-none disabled:opacity-50",
            )}
          >
            {busy ? (
              <Loader2 aria-hidden className="size-4 animate-spin" />
            ) : (
              <Plus aria-hidden className="size-4" />
            )}
            {busy ? 'Queueing…' : 'Play next'}
          </button>
        </div>
      </div>
    </div>
  );
}

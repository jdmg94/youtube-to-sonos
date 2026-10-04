"use client";

import { useState } from 'react';
import { searchYouTube } from '@/lib/api/search';
import { api } from '@/lib/api/client';
import { usePersistedState } from './use-persisted-state.ts';
import type { SearchResult } from '@/lib/api/types';
import type { PlayResponse } from '@/lib/api/types';

const AUTOPLAY_KEY = 'yts.autoplay';

export function useSearch(deviceIp: string | null) {
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searchError, setSearchError] = useState<Error | null>(null);

  const [casting, setCasting] = useState<string | null>(null);
  const [castError, setCastError] = useState<Error | null>(null);

  const [autoplay, setAutoplay] = usePersistedState(AUTOPLAY_KEY, true);

  async function search() {
    if (!query.trim()) return;

    setSearching(true);
    setSearchError(null);

    try {
      const response = await searchYouTube(query.trim());
      setResults(response.results);
    } catch (error) {
      setSearchError(error as Error);
    } finally {
      setSearching(false);
    }
  }

  async function cast(
    videoId: string,
    mode: 'now' | 'next'
  ): Promise<PlayResponse | null> {
    if (!deviceIp) return null;

    setCasting(videoId);
    setCastError(null);

    try {
      const response = await api.play({
        url: videoId,
        device_ip: deviceIp,
        autoplay,
        mode,
      });
      return response;
    } catch (error) {
      setCastError(error as Error);
      return null;
    } finally {
      setCasting(null);
    }
  }

  return {
    query,
    setQuery,
    searching,
    results,
    searchError,
    search,
    casting,
    castError,
    cast,
    autoplay,
    setAutoplay,
  };
}

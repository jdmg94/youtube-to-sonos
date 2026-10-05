import type { SearchResponse } from './types';

export async function searchYouTube(
  query: string,
  limit = 10
): Promise<SearchResponse> {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  const response = await fetch(`/api/search?${params}`);

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Search failed');
  }

  return response.json();
}

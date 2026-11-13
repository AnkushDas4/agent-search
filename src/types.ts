import { z } from "zod";

export const httpUrlSchema = z
  .string()
  .trim()
  .url("Must be a valid URL")
  .refine((val) => {
    try {
      const parsed = new URL(val);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }, "Only http:// and https:// URLs are supported");

export const SearchDepthSchema = z.enum(["basic", "advanced"]);
export type SearchDepth = z.infer<typeof SearchDepthSchema>;

export const SearchTopicSchema = z.enum(["general", "news", "code", "research"]);
export type SearchTopic = z.infer<typeof SearchTopicSchema>;

export const SearchRequestSchema = z.object({
  query: z.string().trim().min(1, "query is required").max(500),
  max_results: z.number().int().min(1).max(30).default(10),
  search_depth: SearchDepthSchema.default("basic"),
  topic: SearchTopicSchema.default("general"),
  include_domains: z.array(z.string().trim().min(1)).max(20).optional(),
  exclude_domains: z.array(z.string().trim().min(1)).max(20).optional(),
  include_raw_content: z.boolean().default(false),
});
export type SearchRequest = z.infer<typeof SearchRequestSchema>;

export const ExtractFormatSchema = z.enum(["markdown", "text"]);
export type ExtractFormat = z.infer<typeof ExtractFormatSchema>;

export const ExtractRequestSchema = z.object({
  urls: z.array(httpUrlSchema).min(1, "At least one URL is required").max(10, "Maximum 10 URLs per request"),
  format: ExtractFormatSchema.default("markdown"),
});
export type ExtractRequest = z.infer<typeof ExtractRequestSchema>;

export const CrawlRequestSchema = z.object({
  url: httpUrlSchema,
  max_depth: z.number().int().min(0).max(2).default(1),
  limit: z.number().int().min(1).max(10).default(5),
  include_paths: z.array(z.string().trim().min(1)).max(20).optional(),
});
export type CrawlRequest = z.infer<typeof CrawlRequestSchema>;

export const ResearchRequestSchema = z.object({
  topic: z.string().trim().min(1, "topic is required").max(400),
  max_sources: z.number().int().min(1).max(10).default(5),
});
export type ResearchRequest = z.infer<typeof ResearchRequestSchema>;

export interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
  content?: string;
  score: number;
  source: string;
}

export interface SearchResponse {
  query: string;
  results: SearchResultItem[];
  cached: boolean;
  response_time_ms: number;
}

export interface ExtractResultItem {
  url: string;
  title: string;
  content: string;
  word_count: number;
}

export interface ExtractFailedItem {
  url: string;
  error: string;
}

export interface ExtractResponse {
  results: ExtractResultItem[];
  failed: ExtractFailedItem[];
}

export interface CrawlPageItem {
  url: string;
  depth: number;
  title: string;
  content: string;
  word_count: number;
}

export interface CrawlResponse {
  url: string;
  pages: CrawlPageItem[];
  total_pages: number;
  failed: ExtractFailedItem[];
  response_time_ms: number;
}

export interface ResearchCitation {
  index: number;
  title: string;
  url: string;
  snippet: string;
  source: string;
  word_count: number;
}

export interface ResearchSourceItem extends ResearchCitation {
  content: string;
}

export interface ResearchResponse {
  topic: string;
  queries: string[];
  citations: ResearchCitation[];
  sources: ResearchSourceItem[];
  context_markdown: string;
  failed: ExtractFailedItem[];
  cached: boolean;
  response_time_ms: number;
}

export interface RawEngineResult {
  title: string;
  url: string;
  snippet: string;
  source: string;
}

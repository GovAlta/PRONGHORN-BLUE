import { useState, useEffect, useCallback, useRef } from "react";
import { pronghornApi } from "@/integrations/pronghorn-api/client";

export interface BuildBook {
  id: string;
  name: string;
  short_description: string | null;
  long_description: string | null;
  cover_image_url: string | null;
  tags: string[];
  org_id: string | null;
  is_published: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  prompt: string | null;
}

export interface BuildBookStandard {
  id: string;
  build_book_id: string;
  standard_id: string;
  created_at: string;
}

export interface BuildBookTechStack {
  id: string;
  build_book_id: string;
  tech_stack_id: string;
  created_at: string;
}

export const useRealtimeBuildBooks = () => {
  const [buildBooks, setBuildBooks] = useState<BuildBook[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const channelRef = useRef<ReturnType<typeof pronghornApi.channel> | null>(null);

  const loadBuildBooks = useCallback(async () => {
    setIsLoading(true);
    try {
      const { data, error } = await pronghornApi.rpc("get_build_books");

      if (error) throw error;
      setBuildBooks((data as BuildBook[]) || []);
    } catch (error) {
      console.error("Error loading build books:", error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadBuildBooks();

    const channel = pronghornApi
      .channel("build-books-realtime")
      .on("broadcast", { event: "build_books_refresh" }, () => loadBuildBooks())
      .subscribe();

    channelRef.current = channel;

    return () => {
      pronghornApi.removeChannel(channel);
      channelRef.current = null;
    };
  }, [loadBuildBooks]);

  return {
    buildBooks,
    isLoading,
    refresh: loadBuildBooks,
  };
};

export const useBuildBookDetail = (buildBookId: string | undefined) => {
  const [buildBook, setBuildBook] = useState<BuildBook | null>(null);
  const [standards, setStandards] = useState<BuildBookStandard[]>([]);
  const [techStacks, setTechStacks] = useState<BuildBookTechStack[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const loadBuildBook = useCallback(async () => {
    if (!buildBookId) return;
    
    setIsLoading(true);
    try {
      const [bookResult, standardsResult, techStacksResult] = await Promise.all([
        pronghornApi.rpc("get_build_book_by_id", { p_id: buildBookId }),
        pronghornApi.rpc("get_build_book_standards", { p_build_book_id: buildBookId }),
        pronghornApi.rpc("get_build_book_tech_stacks", { p_build_book_id: buildBookId }),
      ]);

      if (bookResult.error) throw bookResult.error;
      
      setBuildBook(bookResult.data as BuildBook);
      setStandards((standardsResult.data as BuildBookStandard[]) || []);
      setTechStacks((techStacksResult.data as BuildBookTechStack[]) || []);
    } catch (error) {
      console.error("Error loading build book:", error);
    } finally {
      setIsLoading(false);
    }
  }, [buildBookId]);

  useEffect(() => {
    loadBuildBook();

    if (!buildBookId) return;

    const channel = pronghornApi
      .channel(`build-book-${buildBookId}`)
      .on("broadcast", { event: "build_book_refresh" }, () => loadBuildBook())
      .subscribe();

    return () => {
      pronghornApi.removeChannel(channel);
    };
  }, [buildBookId, loadBuildBook]);

  return {
    buildBook,
    standards,
    techStacks,
    isLoading,
    refresh: loadBuildBook,
  };
};

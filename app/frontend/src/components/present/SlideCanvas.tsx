import { useRef, useEffect, useState, ReactNode } from "react";

interface SlideCanvasProps {
  children: ReactNode;
  className?: string;
  /** Fixed design width (default 960) */
  designWidth?: number;
  /** Fixed design height (default 540) */
  designHeight?: number;
}

/**
 * SlideCanvas provides uniform transform-based scaling for presentation slides.
 * 
 * It renders children at a fixed "design size" (960x540 by default), then applies
 * CSS transform: scale() to fit any container while maintaining exact proportions.
 * 
 * This ensures thumbnails, editor view, fullscreen, and PDF export all look identical
 * - just at different scales.
 */
export function SlideCanvas({ 
  children, 
  className = "",
  designWidth = 960,
  designHeight = 540 
}: SlideCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const updateScale = () => {
      if (!containerRef.current) return;
      
      const containerWidth = containerRef.current.clientWidth;
      const containerHeight = containerRef.current.clientHeight;
      
      if (containerWidth === 0 || containerHeight === 0) return;
      
      const scaleX = containerWidth / designWidth;
      const scaleY = containerHeight / designHeight;
      const newScale = Math.min(scaleX, scaleY);
      
      setScale(newScale);
    };

    updateScale();

    const observer = new ResizeObserver(updateScale);
    if (containerRef.current) {
      observer.observe(containerRef.current);
    }

    return () => observer.disconnect();
  }, [designWidth, designHeight]);

  // Calculate scaled dimensions
    
  return (
    <div 
      ref={containerRef}
      className={`relative overflow-hidden ${className}`}
      style={{ 
        // Use aspect ratio to maintain 16:9 but constrain to parent
        width: "100%",
        height: "100%",
        maxWidth: "100%",
        maxHeight: "100%",
      }}
    >
      {/* Centering wrapper - positions the scaled content */}
      <div 
        className="absolute inset-0 flex items-center justify-center"
        style={{ pointerEvents: "none" }}
      >
        {/* Scaled content container - fixed design size with transform */}
        <div
          style={{
            width: designWidth,
            height: designHeight,
            transform: `scale(${scale})`,
            transformOrigin: "center center",
            pointerEvents: "auto",
            flexShrink: 0,
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

/**
 * SlideCanvasFixed is used for PDF export and thumbnail generation where we need
 * the slide rendered at an exact pixel size without scaling.
 */
export function SlideCanvasFixed({ 
  children, 
  width = 1920, 
  height = 1080,
  className = ""
}: { 
  children: ReactNode; 
  width?: number; 
  height?: number;
  className?: string;
}) {
  return (
    <div 
      className={className}
      style={{
        width,
        height,
        overflow: "hidden",
      }}
    >
      {children}
    </div>
  );
}

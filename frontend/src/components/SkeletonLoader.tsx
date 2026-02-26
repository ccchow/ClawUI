"use client";

function SkeletonLine({ width = "w-full" }: { width?: string }) {
  return <div className={`h-3 rounded ${width} bg-bg-tertiary animate-pulse`} />;
}

function CardSkeleton() {
  return (
    <div className="rounded-xl border border-border-primary bg-bg-secondary p-4 space-y-3">
      <div className="flex items-center gap-2">
        <div className="w-2 h-2 rounded-full bg-bg-tertiary animate-pulse" />
        <SkeletonLine width="w-2/5" />
        <div className="ml-auto w-12 h-3 rounded bg-bg-tertiary animate-pulse" />
      </div>
      <SkeletonLine width="w-4/5" />
      <SkeletonLine width="w-3/5" />
    </div>
  );
}

function NodeCardSkeleton() {
  return (
    <div className="rounded-xl border border-border-primary bg-bg-secondary p-4 space-y-3">
      <div className="flex items-center gap-3">
        <div className="w-3 h-3 rounded-full bg-bg-tertiary animate-pulse flex-shrink-0" />
        <SkeletonLine width="w-1/2" />
        <div className="ml-auto w-16 h-5 rounded-full bg-bg-tertiary animate-pulse" />
      </div>
      <div className="pl-6 space-y-2">
        <SkeletonLine width="w-full" />
        <SkeletonLine width="w-3/4" />
      </div>
    </div>
  );
}

function NodeDetailSkeleton() {
  return (
    <div className="space-y-6">
      {/* Back link */}
      <div className="w-32 h-4 rounded bg-bg-tertiary animate-pulse" />

      {/* Title bar */}
      <div className="flex items-center gap-3">
        <div className="w-3 h-3 rounded-full bg-bg-tertiary animate-pulse" />
        <div className="h-6 w-2/3 rounded bg-bg-tertiary animate-pulse" />
        <div className="ml-auto w-20 h-6 rounded-full bg-bg-tertiary animate-pulse" />
      </div>

      {/* Description block */}
      <div className="rounded-xl border border-border-primary bg-bg-secondary p-4 space-y-3">
        <SkeletonLine width="w-full" />
        <SkeletonLine width="w-5/6" />
        <SkeletonLine width="w-4/6" />
        <SkeletonLine width="w-3/4" />
      </div>

      {/* Action buttons area */}
      <div className="flex gap-2">
        <div className="w-24 h-9 rounded-lg bg-bg-tertiary animate-pulse" />
        <div className="w-28 h-9 rounded-lg bg-bg-tertiary animate-pulse" />
      </div>

      {/* Execution history placeholder */}
      <div className="space-y-3">
        <div className="w-40 h-4 rounded bg-bg-tertiary animate-pulse" />
        <div className="rounded-xl border border-border-primary bg-bg-secondary p-4 space-y-2">
          <SkeletonLine width="w-1/3" />
          <SkeletonLine width="w-2/3" />
        </div>
      </div>
    </div>
  );
}

type SkeletonVariant = "card" | "list" | "nodeCard" | "nodeDetail";

export function SkeletonLoader({
  variant,
  count = 3,
}: {
  variant: SkeletonVariant;
  count?: number;
}) {
  if (variant === "nodeDetail") {
    return <NodeDetailSkeleton />;
  }

  const Item = variant === "nodeCard" ? NodeCardSkeleton : CardSkeleton;

  if (variant === "list" || variant === "nodeCard") {
    return (
      <div className="space-y-2">
        {Array.from({ length: count }, (_, i) => (
          <Item key={i} />
        ))}
      </div>
    );
  }

  return <Item />;
}

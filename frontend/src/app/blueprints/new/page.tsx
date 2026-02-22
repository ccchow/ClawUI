"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createBlueprint } from "@/lib/api";

export default function NewBlueprintPage() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [projectCwd, setProjectCwd] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent, autoGenerate = false) => {
    e.preventDefault();
    if (!title.trim()) return;

    setSubmitting(true);
    setError(null);
    try {
      const bp = await createBlueprint({
        title: title.trim(),
        description: description.trim() || undefined,
        projectCwd: projectCwd.trim() || undefined,
      });
      router.push(autoGenerate ? `/blueprints/${bp.id}?generate=true` : `/blueprints/${bp.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  };

  return (
    <div>
      <Link
        href="/blueprints"
        className="text-sm text-text-muted hover:text-text-secondary transition-colors mb-4 inline-block"
      >
        ← Back to Blueprints
      </Link>

      <h1 className="text-xl font-semibold mb-6">New Blueprint</h1>

      <form onSubmit={handleSubmit} className="space-y-4 max-w-lg">
        <div>
          <label htmlFor="title" className="block text-sm text-text-secondary mb-1">
            Title <span className="text-accent-red">*</span>
          </label>
          <input
            id="title"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g., Build Next.js Full-Stack App"
            className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border-primary text-text-primary placeholder:text-text-muted text-sm focus:outline-none focus:border-accent-blue focus:ring-1 focus:ring-accent-blue/30"
            required
            autoFocus
          />
        </div>

        <div>
          <label htmlFor="description" className="block text-sm text-text-secondary mb-1">
            Description
          </label>
          <textarea
            id="description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="High-level goal and context for this blueprint..."
            rows={4}
            className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border-primary text-text-primary placeholder:text-text-muted text-sm focus:outline-none focus:border-accent-blue focus:ring-1 focus:ring-accent-blue/30 resize-y"
          />
        </div>

        <div>
          <label htmlFor="projectCwd" className="block text-sm text-text-secondary mb-1">
            Project Directory
          </label>
          <input
            id="projectCwd"
            type="text"
            value={projectCwd}
            onChange={(e) => setProjectCwd(e.target.value)}
            placeholder="/path/to/project"
            className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border-primary text-text-primary placeholder:text-text-muted text-sm focus:outline-none focus:border-accent-blue focus:ring-1 focus:ring-accent-blue/30 font-mono"
          />
        </div>

        {error && (
          <div className="text-sm text-accent-red bg-accent-red/10 rounded-lg p-3">
            {error}
          </div>
        )}

        <div className="flex gap-3 pt-2">
          <button
            type="submit"
            disabled={!title.trim() || submitting}
            className="px-4 py-2 rounded-lg bg-accent-blue text-white text-sm font-medium hover:bg-accent-blue/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? "Creating..." : "Create Blueprint"}
          </button>
          <button
            type="button"
            disabled={!title.trim() || submitting}
            onClick={(e) => handleSubmit(e as unknown as React.FormEvent, true)}
            className="px-4 py-2 rounded-lg bg-accent-purple text-white text-sm font-medium hover:bg-accent-purple/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? "Creating..." : "Create & Generate"}
          </button>
          <Link
            href="/blueprints"
            className="px-4 py-2 rounded-lg border border-border-primary text-text-secondary text-sm hover:bg-bg-tertiary transition-colors"
          >
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}

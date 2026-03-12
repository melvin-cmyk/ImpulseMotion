"use client";

import { useState, useEffect, useCallback } from "react";
import { Users, X, Check } from "lucide-react";
import { getAudienceTags, setAudienceTag, removeAudienceTag } from "@/lib/audience-config";

interface AudienceTagInputProps {
  creativeId: string;
}

export function AudienceTagInput({ creativeId }: AudienceTagInputProps) {
  const [audience, setAudience] = useState<string>("");
  const [input, setInput] = useState("");
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    const tags = getAudienceTags();
    setAudience(tags[creativeId] ?? "");
  }, [creativeId]);

  const handleSave = useCallback(() => {
    const trimmed = input.trim();
    if (trimmed) {
      setAudienceTag(creativeId, trimmed);
      setAudience(trimmed);
    } else {
      removeAudienceTag(creativeId);
      setAudience("");
    }
    setEditing(false);
    setInput("");
  }, [creativeId, input]);

  const handleRemove = useCallback(() => {
    removeAudienceTag(creativeId);
    setAudience("");
    setEditing(false);
    setInput("");
  }, [creativeId]);

  const handleEdit = () => {
    setInput(audience);
    setEditing(true);
  };

  return (
    <div>
      <p className="text-[9px] uppercase tracking-widest text-gray-600 font-bold mb-3 flex items-center gap-1.5">
        <Users className="w-3 h-3" />
        Intended Audience
      </p>
      <div className="bg-[#13131f] border border-white/5 rounded-xl p-4">
        {editing ? (
          <div className="flex gap-2">
            <input
              type="text"
              value={input}
              autoFocus
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSave();
                if (e.key === "Escape") { setEditing(false); setInput(""); }
              }}
              placeholder="e.g. Moms 25-45, Gym Bros, Pet Owners…"
              className="flex-1 bg-gray-800/60 border border-white/8 rounded-lg px-3 py-1.5 text-xs text-gray-200 placeholder-gray-600 outline-none focus:border-violet-500/50 transition-colors"
            />
            <button
              onClick={handleSave}
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-violet-600/20 border border-violet-500/30 text-violet-400 hover:bg-violet-600/30 transition-colors text-xs font-semibold"
            >
              <Check className="w-3 h-3" />
              Save
            </button>
          </div>
        ) : audience ? (
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full bg-blue-500/15 text-blue-300 border border-blue-500/25">
              <Users className="w-3 h-3" />
              {audience}
            </span>
            <button
              onClick={handleEdit}
              className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
            >
              Edit
            </button>
            <button
              onClick={handleRemove}
              className="text-gray-600 hover:text-red-400 transition-colors"
              aria-label="Remove audience tag"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        ) : (
          <button
            onClick={handleEdit}
            className="text-xs text-gray-500 hover:text-gray-300 transition-colors flex items-center gap-1.5"
          >
            <Users className="w-3.5 h-3.5" />
            Assign an audience label…
          </button>
        )}
      </div>
    </div>
  );
}

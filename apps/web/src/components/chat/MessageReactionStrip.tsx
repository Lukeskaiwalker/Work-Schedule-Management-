import { useState } from "react";
import type { MessageReactionSummary } from "../../types";

/** Default emoji palette shown by the picker. Curated rather than
 *  exhaustive — covers the common reactions without overwhelming the
 *  UI. Easily extended by adding to this array. */
const QUICK_PICKER_EMOJIS = ["👍", "❤️", "😂", "🎉", "👏", "🔥", "🙏", "👀"];

type Props = {
  /** Existing reactions on the message, aggregated per emoji server-side. */
  reactions: MessageReactionSummary[];
  /** Toggles the current user's reaction. Same callback handles both
   *  add and remove — the backend picks based on existing state. */
  onToggle: (emoji: string) => void;
  language: "de" | "en";
};

/**
 * Renders the strip below a message bubble:
 *   [👍 3] [❤️ 1] [+]
 *
 * Each existing-bucket button toggles the current user's reaction with
 * that emoji. The trailing "+" opens a small palette of quick-pick
 * emojis to add a new reaction.
 */
export function MessageReactionStrip({ reactions, onToggle, language }: Props) {
  const de = language === "de";
  const [pickerOpen, setPickerOpen] = useState(false);

  function handleQuickPick(emoji: string) {
    setPickerOpen(false);
    onToggle(emoji);
  }

  if (reactions.length === 0 && !pickerOpen) {
    return (
      <div className="message-reactions">
        <button
          type="button"
          className="message-reactions-add message-reactions-add--ghost"
          onClick={() => setPickerOpen(true)}
          aria-label={de ? "Reaktion hinzufügen" : "Add reaction"}
          title={de ? "Reaktion hinzufügen" : "Add reaction"}
        >
          +
        </button>
      </div>
    );
  }

  return (
    <div className="message-reactions">
      {reactions.map((bucket) => (
        <button
          key={`reaction-${bucket.emoji}`}
          type="button"
          className={
            bucket.me_reacted
              ? "message-reactions-bucket message-reactions-bucket--mine"
              : "message-reactions-bucket"
          }
          onClick={() => onToggle(bucket.emoji)}
          aria-label={
            bucket.me_reacted
              ? de
                ? `Reaktion ${bucket.emoji} entfernen`
                : `Remove ${bucket.emoji} reaction`
              : de
                ? `Mit ${bucket.emoji} reagieren`
                : `React with ${bucket.emoji}`
          }
          aria-pressed={bucket.me_reacted}
        >
          <span className="message-reactions-bucket-emoji">{bucket.emoji}</span>
          <span className="message-reactions-bucket-count">{bucket.count}</span>
        </button>
      ))}
      <button
        type="button"
        className="message-reactions-add"
        onClick={() => setPickerOpen((current) => !current)}
        aria-label={de ? "Reaktion hinzufügen" : "Add reaction"}
        title={de ? "Reaktion hinzufügen" : "Add reaction"}
      >
        +
      </button>
      {pickerOpen && (
        <div
          className="message-reactions-picker"
          role="menu"
          aria-label={de ? "Emoji auswählen" : "Pick emoji"}
        >
          {QUICK_PICKER_EMOJIS.map((emoji) => (
            <button
              key={`reaction-pick-${emoji}`}
              type="button"
              className="message-reactions-picker-btn"
              onClick={() => handleQuickPick(emoji)}
              aria-label={`${de ? "Mit" : "React with"} ${emoji}`}
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

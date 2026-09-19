/**
 * "📎 n" on a task row: the office attached a plan or a photo, so the person
 * opening the task should expect one. Nothing when there is nothing — most
 * tasks carry no file, and a clip on every row would say nothing.
 *
 * One component for every surface that lists tasks (the row summary, the
 * planning board, the project tab), so the clip reads the same everywhere.
 */
import type { Language, Task } from "../../types";
import { attachmentCountLabel } from "./taskAttachmentsModel";
import "../../styles/tasks.css";

type Props = {
  task: Pick<Task, "attachment_count">;
  language: Language;
};

export function TaskAttachmentBadge({ task, language }: Props) {
  const count = task.attachment_count ?? 0;
  if (count <= 0) return null;
  const label = attachmentCountLabel(count, language);
  // role="img": the clip is a picture of a fact, and the label is what a
  // screen reader should say instead of "paperclip three".
  return (
    <span className="task-attachment-badge" role="img" aria-label={label} title={label}>
      {`📎 ${count}`}
    </span>
  );
}

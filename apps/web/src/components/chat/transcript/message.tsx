/** @jsxImportSource preact */
import { Markdown } from "./markdown";
import { ReplyStatus } from "./reply-status";

interface MessageProps {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly streaming?: boolean;
}

export const Message = ({ role, text, streaming = false }: MessageProps) => (
  <article class={`message group mb-7 wrap-anywhere ${role}`}>
    <div class="message-label mb-1.5 text-xs font-medium text-accent group-[.user]:text-cream">
      {role === "user" ? "You" : "Poppet"}
      {streaming && (
        <>
          {" "}
          <ReplyStatus responding={!!text} />
        </>
      )}
    </div>
    {role === "assistant" ? (
      <Markdown text={text} />
    ) : (
      <div class="whitespace-pre-wrap">{text}</div>
    )}
  </article>
);

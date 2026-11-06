/** @jsxImportSource preact */
export const ReplyStatus = ({ responding }: { readonly responding: boolean }) => (
  <span class={`pl-2 font-normal text-muted ${responding ? "" : "motion-safe:animate-thinking"}`}>
    {responding ? "Responding…" : "Thinking…"}
  </span>
);

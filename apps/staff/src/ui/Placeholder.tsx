/**
 * Marks a part of the shell not built yet, naming its inventory ids so it is never mistaken for a
 * SPK-UX-008 empty state.
 */
export function Placeholder({
  screenIds,
  title,
  purpose,
}: {
  screenIds: string;
  title: string;
  purpose: string;
}) {
  return (
    <section className="placeholder" aria-label={`${title}: not built yet`}>
      <h3>{title}</h3>
      <p>{purpose}</p>
      <p className="caption">Not built yet ({screenIds}).</p>
    </section>
  );
}

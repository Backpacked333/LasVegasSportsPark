/**
 * The page a Package G staff screen shows until its screen group builds it (SCR-S-51 to SCR-S-57,
 * §6.5): its heading, the area's own navigation, and behind its `CapabilityGate` the "not built
 * yet" marker with what stays pending once the capability is on. While the switch is off
 * (DEC-016, every switch starts off) the gate shows the turned-off state instead.
 */
import type { ReactNode } from 'react';
import { CapabilityGate } from '../../ui/CapabilityGate';
import { Placeholder } from '../../ui/Placeholder';
import { StateView } from '../../ui/StateView';
import type { PackageGScreen } from './registry';

export function PackageGPlaceholder({
  screen,
  headingLevel = 2,
  nav,
}: {
  screen: PackageGScreen;
  /** 3 inside an area that already shows its own level-2 heading (Schedule). */
  headingLevel?: 2 | 3;
  /** The area's section navigation, when the area's other pages show one. */
  nav?: ReactNode;
}) {
  const headingId = `package-g-${screen.slug}`;
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <section aria-labelledby={headingId} data-testid={`package-g-${screen.slug}`}>
      <Heading id={headingId}>{screen.title}</Heading>
      {nav}
      <CapabilityGate capability={screen.capability} subject={screen.title}>
        <Placeholder
          screenIds={screen.id}
          title={screen.title}
          purpose={`${screen.purpose} (${screen.requirements})`}
        />
        {screen.pending ? (
          <StateView
            variant="pending-decision"
            subject={screen.pending.subject}
            decisions={[...screen.pending.decisions]}
            owner={screen.pending.owner}
          />
        ) : null}
      </CapabilityGate>
    </section>
  );
}

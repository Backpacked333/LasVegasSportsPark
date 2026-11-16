# CTO: glass-demo-amendments

- **Problem.** The facility depends on ten things the product does not do (pull request 23), the
  product cannot be shown to anyone because its screens start empty, and the owner finds the
  interface neither clean nor distinctive enough.
- **Build or buy.** Build. Each amendment extends a module that already owns the surrounding
  rules (prices, forms, bookings, team entries, messages, register); an outside product would
  duplicate records the specification requires to be one. The glass optics on the web are a small
  owned module. On mobile two platform packages are added behind one primitive (ADR-001).
- **Direction.** Amendments are built as proposals behind switches (ADR-002) so that the
  facility's answers change configuration, not code.
- **Cost accepted by the owner.** One very large pull request rather than staged ones: later
  feedback, harder review, one failing part holds the rest.
- **Not decided here.** DEC-095 to DEC-104 stay with the facility; providers stay unselected.

import { RadioTower, Settings2, UsersRound } from 'lucide-react';

const icons = { Contactos: UsersRound, Canales: RadioTower, Sistema: Settings2 };

export function SectionPlaceholder({ title }: { title: keyof typeof icons }) {
  const Icon = icons[title];
  return (
    <section className="section-placeholder" aria-labelledby="section-title">
      <div className="empty-icon-wrap"><Icon aria-hidden="true" size={20} /></div>
      <p className="eyebrow">SDK-BOT</p>
      <h1 id="section-title">{title}</h1>
      <p>Esta sección se incorporará después de completar la bandeja de conversaciones.</p>
    </section>
  );
}

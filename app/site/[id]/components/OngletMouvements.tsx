'use client';

/**
 * Le registre de caisse, sur sa propre page — pour le caissier seul.
 *
 * Il ne fait que cela, et il le fait au téléphone. Sous les trois cartes
 * de « Fonds disponible », le tableau commençait hors champ : pour relire
 * une écriture il fallait dépasser les chiffres, et pour relire un solde,
 * remonter au-dessus du tableau.
 *
 * Les autres rôles gardent ce même registre sous leurs chiffres, dans
 * « Fonds de caisse » : pour eux la caisse est une partie du travail, pas
 * le travail. Les deux écrans partagent {@link RegistreCaisse}.
 */

import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth-context';
import { Loader2, Scale } from 'lucide-react';
import ModalEcartCaisse from './ModalEcartCaisse';
import { hankenGrotesk } from './finance/font';
import {
  chargerCaisseDuSite, soldeCaisse, type MouvementCaisse,
} from '@/lib/caisse';
import { roleSurSite, type RoleSite } from '@/lib/roles';
import PeriodFilter from './finance/PeriodFilter';
import RegistreCaisse from './RegistreCaisse';
import { useSites, FiltreSite, type PropsPortee } from './ContexteSites';

interface Props extends PropsPortee {
  userId: string;
}

type Periode = 'jour' | 'semaine' | 'mois' | 'annee' | 'tout';

/** Date de début d'une période nommée ; chaîne vide = depuis toujours. */
function debutPeriode(p: Periode): string {
  const d = new Date();
  if (p === 'jour') return d.toISOString().split('T')[0];
  if (p === 'semaine') {
    const jour = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - jour);
    return d.toISOString().split('T')[0];
  }
  if (p === 'mois') { d.setDate(1); return d.toISOString().split('T')[0]; }
  if (p === 'annee') { d.setMonth(0, 1); return d.toISOString().split('T')[0]; }
  return '';
}

export default function OngletMouvements({ siteId, userId, sites, titre }: Props) {
  const { activite, profile: profil } = useAuth();
  const ctx = useSites(siteId, sites);
  const [mouvements, setMouvements] = useState<MouvementCaisse[]>([]);
  const [roleSite, setRoleSite] = useState<RoleSite | null>(null);
  const [loading, setLoading] = useState(true);
  const [periode, setPeriode] = useState<Periode>('jour');
  /* incrémenté après une saisie : relance le chargement */
  const [version, setVersion] = useState(0);
  /* Constater un ecart : le caissier compte son tiroir, il ne decide de
     rien. Le solde ne bougera qu'une fois le constat reconnu. */
  const [modalEcart, setModalEcart] = useState(false);

  useEffect(() => {
    const charger = async () => {
      setLoading(true);
      /* Le rôle se lit avant de rendre, pas pendant : `null` veut dire
         « aucune restriction », si bien qu'un rendu fait avant sa réponse
         montrait le bouton de saisie au caissier, le temps d'un battement,
         avant de le lui retirer. */
      const [registre, role] = await Promise.all([
        chargerCaisseDuSite(ctx.portee),
        ctx.siteEcriture
          ? roleSurSite(userId, ctx.siteEcriture, activite?.adminUid)
              .catch(() => null)
          : Promise.resolve(null),
      ]);
      setMouvements(registre);
      setRoleSite(role);
      setLoading(false);
    };
    charger();
  }, [ctx.portee, userId, version]);

  if (loading) return (
    <div className="flex min-h-64 items-center justify-center">
      <Loader2 size={24} className="animate-spin text-indigo-500" />
    </div>
  );

  const depuis = debutPeriode(periode);
  const surPeriode = mouvements.filter(m => !depuis || (m.date ?? '') >= depuis);

  return (
    <div className={`${hankenGrotesk.className} flex flex-col gap-4`}>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className={titre
          ? 'text-xl font-bold text-neutral-900 dark:text-neutral-100'
          : 'text-sm font-bold text-neutral-900 dark:text-neutral-100'}>
          {titre ?? 'Mouvements de caisse'}
        </p>
        <div className="flex items-center gap-2">
          <FiltreSite sites={ctx.sites} valeur={ctx.filtre} onChange={ctx.setFiltre} />
          <PeriodFilter periode={periode} onChange={setPeriode} />

        </div>
      </div>

      <div className="rounded-2xl border border-gray-100 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-900 sm:p-5">
        <RegistreCaisse mouvements={surPeriode} userId={userId}
          roleSite={roleSite} siteEcriture={ctx.siteEcriture}
          nomDuSite={ctx.ensemble ? ctx.nomDe : null}
          onChange={() => setVersion(v => v + 1)}
          /* Sur la ligne de recherche, avec le filtre : au-dessus, il
             occupait une ligne à lui, loin du registre qu'il concerne. */
          actions={ctx.siteEcriture ? (
            <button type="button" onClick={() => setModalEcart(true)}
              title="Constater un écart"
              className="flex shrink-0 items-center gap-1.5 rounded-xl border border-gray-200 px-3 py-2 text-xs font-bold text-gray-600 transition-colors hover:border-indigo-400 hover:text-indigo-600 dark:border-gray-700 dark:text-gray-300">
              <Scale size={13} />
              <span className="hidden sm:inline">Écart</span>
            </button>
          ) : undefined} />
      </div>

      {modalEcart && ctx.siteEcriture && (
        <ModalEcartCaisse siteId={ctx.siteEcriture}
          utilisateur={userId}
          utilisateurNom={profil?.nom ?? null}
          utilisateurFonction={roleSite ?? 'Propriétaire'}
          roleSite={roleSite}
          /* Sur tout le registre, non sur la periode affichee : un ecart
             se mesure contre ce que le tiroir contient maintenant. */
          soldeTheorique={soldeCaisse(mouvements)}
          onFermer={() => setModalEcart(false)}
          onEnregistre={() => setVersion(v => v + 1)} />
      )}
    </div>
  );
}

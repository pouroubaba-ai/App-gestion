'use client';

/**
 * L'argent qui attend d'entrer au tiroir, et ce qu'on en a décidé.
 *
 * Ce bandeau vivait en bas de « Fonds disponible ». C'est pourtant le seul
 * écran du caissier qui demande une action : les autres se lisent, celui-ci
 * se traite. Rangé sous des chiffres, il se découvrait par hasard ; ici il
 * a son onglet, et sa pastille dit combien de gestes restent.
 *
 * Elle ne garde que ce qui attend. Un mouvement autorisé est passé au
 * registre, un mouvement refusé est rendu à celui qui l'a déclaré : ni
 * l'un ni l'autre ne réclame plus rien ici, et les laisser sous la file
 * ferait chercher le travail à faire au milieu de ce qui est fait.
 *
 * Rien ne se perd pour autant. L'autorisation écrit au registre, avec son
 * numéro et le nom de qui a ouvert le tiroir ; le refus reste lisible dans
 * « Mes remises », chez celui qui avait déclaré.
 */

import { useEffect, useState } from 'react';
import { formatMontant } from '@/lib/format';
import { useAuth } from '@/lib/auth-context';
import { Loader2, ShieldCheck } from 'lucide-react';
import { hankenGrotesk } from './finance/font';
import {
  chargerAttente, totauxEnAttente, type MouvementAttente,
} from '@/lib/attente-caisse';
import { roleSurSite, peutAutoriserCaisse, type RoleSite } from '@/lib/roles';
import MouvementsEnAttente from './MouvementsEnAttente';
import { chargerMissions, type Mission } from '@/lib/missions';
import { chargerDisponible } from '@/lib/attente-caisse';
import AttenteParAuteur from './AttenteParAuteur';
import { useSites, FiltreSite, type PropsPortee } from './ContexteSites';

interface Props extends PropsPortee {
  userId: string;
}

export default function OngletAutorisations({
  siteId, userId, sites, titre,
}: Props) {
  const { profile: profil, activite } = useAuth();
  const ctx = useSites(siteId, sites);
  const [attente, setAttente] = useState<MouvementAttente[]>([]);
  /* Les paiements à porter : l'argent sort du tiroir mais n'arrive pas
     chez le fournisseur, il passe par quelqu'un. */
  const [missions, setMissions] = useState<Mission[]>([]);
  /* Ce que la caisse peut encore laisser sortir : délivrer une mission
     est une sortie comme une autre. */
  const [dispo, setDispo] = useState<number | null>(null);
  const [roleSite, setRoleSite] = useState<RoleSite | null>(null);
  const [loading, setLoading] = useState(true);
  /* Quel sens on traite. Les entrées d'abord : c'est ce qui attend le plus
     souvent, et faire entrer l'argent prime sur le faire sortir. */
  const [sens, setSens] = useState<'entree' | 'sortie'>('entree');
  /* Par mouvement ou par auteur. Un porteur remet ce qu'il a collecté en
     une fois : la vue par auteur épouse ce geste. Par mouvement d'abord,
     parce qu'on vient d'abord voir ce qui attend. */
  const [vue, setVue] = useState<'mouvements' | 'auteurs'>('mouvements');
  /* Un mouvement sorti de son lot, pour le compter seul. */
  const [aCompter, setACompter] = useState<MouvementAttente | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const charger = async () => {
      setLoading(true);
      /* Le rôle se lit avant de rendre : sans lui, `peutAutoriser` décide
         sur un `null` qui vaut « admin », et les boutons d'autorisation
         apparaîtraient à qui n'y a pas droit, le temps d'un battement. */
      const [liste, role] = await Promise.all([
        chargerAttente(ctx.portee).catch(() => []),
        ctx.siteEcriture
          ? roleSurSite(userId, ctx.siteEcriture, activite?.adminUid)
              .catch(() => null)
          : Promise.resolve(null),
      ]);
      setAttente(liste);
      setRoleSite(role);
      chargerMissions(ctx.portee).then(setMissions).catch(() => setMissions([]));
      if (ctx.siteEcriture) {
        chargerDisponible(ctx.siteEcriture)
          .then(d => setDispo(d.disponible)).catch(() => setDispo(null));
      }
      setLoading(false);
    };
    charger();
  }, [ctx.portee, userId, version]);

  if (loading) return (
    <div className="flex min-h-64 items-center justify-center">
      <Loader2 size={24} className="animate-spin text-indigo-500" />
    </div>
  );

  const peutAutoriser = peutAutoriserCaisse(roleSite);
  const t = totauxEnAttente(attente);

  /** Ce qui attend dans un sens : la carte le compte, la file le déroule. */
  function enAttenteDe(s: 'entree' | 'sortie') {
    return attente.filter(m => m.etat === 'en_attente' && m.sens === s);
  }

  /* Les missions ne se comptent plus ici.

     Elles pesaient sur le total parce qu'un bloc les montrait juste
     dessous : même tiroir, même geste. Ce bloc parti, le chiffre annonçait
     trois sorties là où la page n'en montrait qu'une — et l'on cherchait
     les deux autres. Un compte ne vaut que s'il compte ce qui est visible. */

  return (
    <div className={`${hankenGrotesk.className} flex flex-col gap-4`}>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className={titre
          ? 'text-xl font-bold text-neutral-900 dark:text-neutral-100'
          : 'text-sm font-bold text-neutral-900 dark:text-neutral-100'}>
          {titre ?? 'Autorisations'}
        </p>
        <FiltreSite sites={ctx.sites} valeur={ctx.filtre} onChange={ctx.setFiltre} />
      </div>

      {/* Deux chiffres, pas un solde : ce qui doit entrer et ce qui doit
          sortir sont deux gestes distincts. Les compenser ferait croire
          qu'il n'y a rien à faire quand les deux s'équilibrent.

          Et deux onglets : on vient traiter l'un ou l'autre, jamais les
          deux mêlés — autoriser une entrée, c'est compter ce qu'on reçoit ;
          autoriser une sortie, c'est vérifier ce qu'on délivre. */}
      <div className="grid grid-cols-2 gap-2 sm:gap-4">
        {([
          {
            key: 'entree' as const, emoji: '📥', titre: 'À faire entrer',
            montant: t.entrees, compte: enAttenteDe('entree').length,
            ton: 'text-green-600 dark:text-green-500',
            actif: 'border-green-400 bg-green-50 dark:border-green-600/50 dark:bg-green-900/15',
            pastille: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
          },
          {
            key: 'sortie' as const, emoji: '📤', titre: 'À faire sortir',
            montant: t.sorties,
            compte: enAttenteDe('sortie').length,
            ton: 'text-red-500 dark:text-red-400',
            actif: 'border-red-400 bg-red-50 dark:border-red-600/50 dark:bg-red-900/15',
            pastille: 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400',
          },
        ]).map(c => {
          const ouvert = sens === c.key;
          return (
            /* L'icône et le libellé sur une ligne, le montant dessous : les
               trois côte à côte, un chiffre en millions poussait le reste
               hors de la carte. Le montant reste petit pour la même raison —
               deux cartes se partagent la largeur d'un téléphone. */
            <button key={c.key} type="button" onClick={() => setSens(c.key)}
              className={`block rounded-2xl border p-3 text-left shadow-sm transition-all hover:-translate-y-0.5 sm:p-4 ${
                ouvert ? c.actif
                  : 'border-black/[0.06] bg-white dark:border-white/10 dark:bg-neutral-900'}`}>
              <span className="flex items-center gap-2">
                <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-[9px] text-[15px] ${
                  ouvert ? 'bg-white/70 dark:bg-black/20' : 'bg-neutral-100 dark:bg-neutral-800'}`}>
                  {c.emoji}
                </span>
                <span className="min-w-0 flex-1 text-[10px] font-bold uppercase leading-tight tracking-wide text-neutral-400">
                  {c.titre}
                </span>
                {c.compte > 0 && (
                  <span className={`shrink-0 whitespace-nowrap rounded-full px-1.5 py-0.5 text-[10px] font-bold ${c.pastille}`}>
                    {c.compte}
                  </span>
                )}
              </span>
              {/* Un montant qui déborde ne se lit plus du tout : il se
                  réduit plutôt que de sortir de sa carte. */}
              <span className={`mt-1.5 block truncate text-[17px] font-bold leading-6 tracking-tight sm:text-[20px] sm:leading-7 ${
                c.montant > 0 ? c.ton : 'text-neutral-900 dark:text-white'}`}>
                {formatMontant(c.montant)}
              </span>
            </button>
          );
        })}
      </div>

      {/* Deux façons de lire la même file. Par mouvement, on traite ligne
          par ligne ; par auteur, on accepte une remise entière. La bascule
          ne s'affiche que s'il y a de quoi grouper. */}
      {enAttenteDe(sens).length > 1 && (
        <div className="flex items-center gap-0.5 self-start rounded-xl bg-gray-100 p-1 dark:bg-gray-800">
          {([
            { cle: 'mouvements' as const, label: 'Par mouvement' },
            { cle: 'auteurs' as const,    label: 'Par auteur' },
          ]).map(o => (
            <button key={o.cle} onClick={() => setVue(o.cle)}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-all ${
                vue === o.cle
                  ? 'bg-white text-indigo-600 shadow-sm dark:bg-gray-700 dark:text-indigo-400'
                  : 'text-gray-400 hover:text-gray-600 dark:text-gray-500'}`}>
              {o.label}
            </button>
          ))}
        </div>
      )}

      {/* La file du sens ouvert : le même composant que le bandeau d'hier,
          qui ne s'affiche pas quand il n'y a rien à traiter. */}
      {vue === 'mouvements' || enAttenteDe(sens).length <= 1 ? (
        <MouvementsEnAttente mouvements={enAttenteDe(sens)}
          peutAutoriser={peutAutoriser} entete={false}
          parUid={userId} parNom={profil?.nom ?? null}
          onChange={() => setVersion(v => v + 1)} />
      ) : (
        <AttenteParAuteur mouvements={enAttenteDe(sens)} sens={sens}
          peutAutoriser={peutAutoriser}
          parUid={userId} parNom={profil?.nom ?? null}
          onChange={() => setVersion(v => v + 1)}
          onOuvrir={setACompter} />
      )}

      {/* Un mouvement tiré de son lot : compter puis autoriser, le même
          écran que dans la vue par mouvement. */}
      {aCompter && (
        <MouvementsEnAttente mouvements={[aCompter]}
          peutAutoriser={peutAutoriser} entete={false}
          ouvertDabord={aCompter}
          parUid={userId} parNom={profil?.nom ?? null}
          onChange={() => { setACompter(null); setVersion(v => v + 1); }}
          onFerme={() => setACompter(null)} />
      )}

      {/* Le vide suit l'onglet ouvert : dire « rien à autoriser » alors que
          l'autre sens en a trois serait faux. */}
      {enAttenteDe(sens).length === 0 && (
        <div className="rounded-2xl border border-gray-100 bg-white px-5 py-10 text-center shadow-sm dark:border-gray-800 dark:bg-gray-900">
          <ShieldCheck size={22} className="mx-auto text-gray-300" />
          <p className="mt-2 text-sm font-bold text-gray-500 dark:text-gray-400">
            {sens === 'entree' ? 'Rien à faire entrer' : 'Rien à faire sortir'}
          </p>
          <p className="mt-1 text-xs text-gray-400">
            {peutAutoriser
              ? 'Tout ce qui a été déclaré de ce côté est passé par le tiroir.'
              : 'Les déclarations en cours apparaîtront ici.'}
          </p>
        </div>
      )}

    </div>
  );
}

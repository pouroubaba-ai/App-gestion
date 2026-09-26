'use client';
import { useEffect, useState } from 'react';
import { collection, query, where, getDocs } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { formatMontant } from '@/lib/format';
import { soldesDuSite, totalRole, restesDesVentes } from '@/lib/soldes';
import { chargerVersementsDuSite } from '@/lib/versements-collection';
import { hankenGrotesk } from './finance/font';
import {
  chargerCaisseDuSite, soldeCaisse, MouvementCaisse, LIBELLES_MOTIF_CAISSE,
} from '@/lib/caisse';
import PeriodFilter from './finance/PeriodFilter';
import { useSites, FiltreSite, type PropsPortee } from './ContexteSites';
import { useRouter, useSearchParams } from 'next/navigation';
import { lireParSite, sitesDe } from '@/lib/portee';
import VentesCard from './finance/VentesCard';
import {
  chargerAttente, totauxEnAttente, type MouvementAttente,
} from '@/lib/attente-caisse';
import { retoursClientsConfirmes } from '@/lib/retours-dossiers';
import VentesBeneficeChart from './finance/VentesBeneficeChart';
import DepensesChart from './finance/DepensesChart';
import CreancesDettesCard from './finance/CreancesDettesCard';
import {
  Loader2, Hourglass,
} from 'lucide-react';

interface Props extends PropsPortee {
  userId: string;
  onNaviguer: (onglet: string) => void;
}

/** Une vente, réduite à ce dont le tableau de bord a besoin. */
interface Vente {
  date: string;
  montant: number;
  benefice: number;
  /* De quel site vient la vente : la vue par site les sépare. */
  siteId?: string | null;
}

interface Depense {
  date: string;
  motif: string;
  montant: number;
  siteId?: string | null;
}

type Periode = 'jour' | 'semaine' | 'mois' | 'annee' | 'tout';

const PERIODES: { key: Periode; label: string }[] = [
  { key: 'jour',    label: "Aujourd'hui" },
  { key: 'semaine', label: 'Semaine' },
  { key: 'mois',    label: 'Mois' },
  { key: 'annee',   label: 'Année' },
  { key: 'tout',    label: 'Tout' },
];

const JOURS = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];
const MOIS = ['Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Juin', 'Juil', 'Août', 'Sep', 'Oct', 'Nov', 'Déc'];

function iso(d: Date): string { return d.toISOString().split('T')[0]; }

/** Début de la période : la borne à partir de laquelle on retient les données. */
function debutPeriode(p: Periode): string {
  const d = new Date();
  if (p === 'jour') return iso(d);
  if (p === 'semaine') {
    /* semaine commençant le lundi */
    const jour = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - jour);
    return iso(d);
  }
  if (p === 'mois') { d.setDate(1); return iso(d); }
  if (p === 'annee') { d.setMonth(0, 1); return iso(d); }
  return '';
}

export default function OngletDashboard({ siteId, userId, onNaviguer, sites, titre }: Props) {
  const ctx = useSites(siteId, sites);
  const router = useRouter();
  const searchParams = useSearchParams();
  const [ventes, setVentes] = useState<Vente[]>([]);
  const [depenses, setDepenses] = useState<Depense[]>([]);
  const [encaissements, setEncaissements] = useState<{ date: string; montant: number }[]>([]);
  const [mouvementsCaisse, setMouvementsCaisse] = useState<MouvementCaisse[]>([]);
  /* Créance et dette de chaque site, pour la vue par site. Vide tant que la
     portée n'en couvre qu'un : il n'y a rien à répartir. */
  const [soldesParSite, setSoldesParSite] =
    useState<Record<string, { creance: number; dette: number }>>({});
  /* Ce qu'on regarde : tout à la fois, ou site par site. L'adresse la
     porte — sans ça, revenir d'un site rouvrait sur l'ensemble, et on
     perdait sa place à chaque aller-retour. */
  const [vue, setVueBrut] = useState<'ensemble' | 'sites'>(
    searchParams?.get('vueSites') === 'sites' ? 'sites' : 'ensemble');
  /* `history.replaceState` plutôt que `router.replace` : le second est une
     navigation, Next relit l'adresse et remonte la page — le chargement
     repart, et l'onglet courant se perd en chemin. Ici on ne veut qu'une
     trace dans l'adresse, pour que revenir d'un site retrouve cette vue. */
  function setVue(v: 'ensemble' | 'sites') {
    setVueBrut(v);
    const p = new URLSearchParams(window.location.search);
    if (v === 'sites') p.set('vueSites', v); else p.delete('vueSites');
    window.history.replaceState(null, '', `?${p.toString()}`);
  }
  const [creance, setCreance] = useState(0);
  /* Ce qui reste dû sur chaque vente, avec sa date : « à encaisser » suit
     le filtre, là où la créance totale dit tout ce qu'on attend. */
  /* Ce qui attend le tiroir : déclaré par quelqu'un, pas encore constaté
     par le caissier. Le tableau de bord le montrait nulle part — il
     fallait ouvrir « Fonds disponible » pour savoir qu'on attendait. */
  const [attente, setAttente] = useState<MouvementAttente[]>([]);
  const [restesVentes, setRestesVentes] = useState<
    { date: string | null; reste: number; siteId: string | null }[]>([]);
  /* Ce que les clients ont rendu. Seuls les retours confirmés comptent :
     tant que la marchandise n'est pas revenue, rien n'a été rendu. */
  const [retours, setRetours] = useState<
    { date: string; montant: number; siteId: string | null }[]>([]);
  const [dette, setDette] = useState(0);
  const [loading, setLoading] = useState(true);
  /* Ce qui s'est passé aujourd'hui : c'est la question qu'on se pose en
     ouvrant l'écran. Les périodes plus larges se demandent, elles ne
     s'imposent pas. */
  const [periode, setPeriode] = useState<Periode>('jour');

  useEffect(() => {
    const charger = async () => {
      setLoading(true);

      /* Le filtrage par date se fait plus bas, en mémoire.
         Le faire côté serveur — un `where('date', '>=', …)` à côté du
         `where('siteId', '==', …)` — donne une requête composée, et
         Firestore exige alors un index créé à la main pour chacune :
         cinq index pour ce seul écran, et l'app en erreur tant qu'ils
         n'existent pas. Le cache disque activé dans lib/firebase.ts
         règle l'essentiel du problème sans rien demander : ces mêmes
         lectures ne repartent plus sur le réseau au second passage. */
      /* Sur plusieurs sites, le `siteId` devient un `in` — le croiser avec
         `userId` ferait une requête composée, donc un index à créer. Le
         second filtre se fait en mémoire, comme celui des dates. */
      const [mvSnap, partSnap, recJSnap, recVSnap, versEmpSnap, avSnap, remEmpSnap, achatSnap] = await Promise.all([
        lireParSite('mouvements', ctx.portee),
        /* Un partenaire appartient au site, pas à celui qui l'a saisi : les
           fiches portent l'identifiant du propriétaire, jamais celui du
           membre qui les consulte. */
        lireParSite('partenaires', ctx.portee),
        lireParSite('recouvrement_journal', ctx.portee),
        lireParSite('recouvrement_versements', ctx.portee),
        lireParSite('employe_versements', ctx.portee),
        lireParSite('employe_avances', ctx.portee),
        lireParSite('employe_remunerations', ctx.portee),
        lireParSite('achats', ctx.portee),
      ]);

      const v: Vente[] = [];
      const d: Depense[] = [];
      mvSnap.forEach(doc => {
        const m = doc.data();
        /* un transfert déplace la valeur sans la réaliser */
        if (m.motif === 'transfert') return;
        if (m.sens === 'sortie' && m.motif === 'vente') {
          /* La marge est figée sur le mouvement au moment du geste. Les lignes
             écrites avant qu'elle le soit ne la portent pas : on la reconstitue
             alors du prix et du coût, que la ligne a toujours gardés. */
          const marge = m.benefice ?? (
            ((m.valeurUnitaire ?? 0) - (m.cout ?? m.valeurUnitaire ?? 0))
            * (m.quantite ?? 0));
          v.push({ date: m.date, montant: m.valeurTotale ?? 0, benefice: marge,
                   siteId: m.siteId ?? null });
        }
        /* Recevoir de la marchandise n'est pas une dépense : aucun argent
           n'est sorti. Ce qui est pris à crédit devient une dette, et c'est
           le règlement qui fait la dépense — sinon on compte deux fois le
           même achat, et la dette ne mesure plus rien. */
      });

      versEmpSnap.forEach(doc => {
        const x = doc.data();
        if (x.montant > 0) d.push({ date: x.date, motif: 'Rémunérations', montant: x.montant,
                                    siteId: x.siteId ?? null });
      });
      /* Une avance et un salaire vont au même endroit : l'employé. Ce qui
         compte pour la caisse, c'est vers qui l'argent part — pas à quel
         moment du cycle. Le détail avance/versement vit dans l'onglet
         Employés, qui est là pour ça. */
      avSnap.forEach(doc => {
        const x = doc.data();
        if (x.montant > 0) d.push({ date: x.date, motif: 'Rémunérations', montant: x.montant,
                                    siteId: x.siteId ?? null });
      });

      /* Tous les versements viennent de leur collection, quelle que soit
         leur origine : imbriqués dans les dossiers ou rattachés à une
         échéance, ils échappaient à toute lecture d'ensemble. */
      const enc: { date: string; montant: number; siteId?: string | null }[] = [];
      for (const v of await chargerVersementsDuSite(ctx.portee)) {
        /* Un retour éteint une dette sans qu'un franc ne circule : le
           compter ici gonflait l'encaissement des ventes et la dépense
           d'achats avec de l'argent qui n'a jamais bougé. */
        if (!(v.montant > 0) || v.motif === 'remboursement'
          || v.motif === 'retour_marchandise') continue;
        if (v.role === 'client') enc.push({ date: v.date, montant: v.montant, siteId: v.siteId ?? null });
        /* l'argent versé au fournisseur : c'est lui, la dépense d'achat */
        else d.push({ date: v.date, motif: 'Achats', montant: v.montant, siteId: v.siteId ?? null });
      }

      /* Ce que le site doit à ses employés. Un salaire acquis et non versé
         est une dette au même titre que celle d'un fournisseur : l'argent
         devra sortir. L'avance, elle, est déjà sortie — elle réduit ce qui
         reste dû, on ne l'ajoute pas, sinon on compterait deux fois. */
      const detteEmp: Record<string, number> = {};
      let detteEmpTotale = 0;
      remEmpSnap.forEach(doc => {
        const x = doc.data();
        const reste = Math.max(0, (x.montant ?? 0) - (x.verse ?? 0));
        if (reste <= 0) return;
        detteEmpTotale += reste;
        const id = x.siteId ?? '';
        detteEmp[id] = (detteEmp[id] ?? 0) + reste;
      });
      /* Créance et dette se déduisent des dossiers non soldés : les lire sur
         la fiche donnait un total qui survivait à leur suppression. */
      const soldes = await soldesDuSite(ctx.portee);
      const cr = totalRole(soldes, 'client').reste;
      restesDesVentes(ctx.portee).then(setRestesVentes).catch(() => setRestesVentes([]));
      chargerAttente(ctx.portee).then(setAttente).catch(() => setAttente([]));
      retoursClientsConfirmes(ctx.portee).then(setRetours).catch(() => setRetours([]));
      /* Fournisseurs et employés : deux créanciers, une seule dette. */
      const de = totalRole(soldes, 'fournisseur').reste + detteEmpTotale;

      /* La vue par site veut les mêmes chiffres, site par site : créance et
         dette s'agrègent par partenaire, pas par site, donc on les relit
         pour chacun. Une lecture par site, faite une seule fois — et
         seulement quand la vue d'ensemble en couvre plusieurs. */
      const ids = sitesDe(ctx.portee);
      if (ids.length > 1) {
        const parSite: Record<string, { creance: number; dette: number }> = {};
        await Promise.all(ids.map(async id => {
          const s = await soldesDuSite(id);
          parSite[id] = {
            creance: totalRole(s, 'client').reste,
            dette: totalRole(s, 'fournisseur').reste + (detteEmp[id] ?? 0),
          };
        }));
        setSoldesParSite(parSite);
      } else setSoldesParSite({});

      setMouvementsCaisse(await chargerCaisseDuSite(ctx.portee));
      setVentes(v);
      setDepenses(d);
      setEncaissements(enc);
      setCreance(cr);
      setDette(de);
      setLoading(false);
    };
    charger();
  }, [ctx.portee, userId]);

  if (loading) return (
    <div className="min-h-64 flex items-center justify-center">
      <Loader2 size={24} className="animate-spin text-indigo-500" />
    </div>
  );

  const debut = debutPeriode(periode);
  const dansPeriode = (date: string) => !debut || (date ?? '') >= debut;

  const ventesP = ventes.filter(v => dansPeriode(v.date));
  const depensesP = depenses.filter(d => dansPeriode(d.date));
  /* Les recouvrements encaissés ne s'additionnent pas à l'encaissé :
     chacun a déjà réduit la créance du partenaire, donc il est compris
     dans `totalVentes - creance`. Les compter à part les doublerait. */

  const totalVentes = ventesP.reduce((s, v) => s + v.montant, 0);
  const totalBenefice = ventesP.reduce((s, v) => s + v.benefice, 0);
  /* rapportés aux ventes : l'encaissé peut dépasser 100 % quand on rattrape des créances */

  /* Le fonds vient du registre, jamais d'un recalcul : deux écrans qui
     additionnent chacun de leur côté donnent deux chiffres pour une seule
     caisse. Le registre dit ce qu'il y a dans le tiroir. */
  const fonds = soldeCaisse(mouvementsCaisse);

  /* À encaisser : ce qui reste dû sur les ventes de la période.
   *
   * La créance totale répond à une autre question — tout ce que les tiers
   * doivent, quelle que soit la date — et c'est la carte Créances qui la
   * porte. Les confondre affichait « Ventes 0 · À encaisser 16 000 » sur
   * une journée sans une seule vente : deux chiffres côte à côte qui ne
   * parlaient pas de la même période. */
  const resteAEncaisser = restesVentes
    .filter(r => dansPeriode(r.date ?? ''))
    .reduce((s, r) => s + r.reste, 0);

  /* Encaissé : ce qui a été vendu sur la période, moins ce qui en reste
     dû. Les deux se rapportent désormais aux mêmes ventes, donc leur
     somme fait le total vendu — ce qui n'était pas le cas tant que la
     créance courante servait de reste. */
  /* Ce qui est revenu sur la période, au prix du document d'origine. */
  const totalRetours = retours
    .filter(r => dansPeriode(r.date))
    .reduce((s, r) => s + r.montant, 0);

  /* Encaissé : ce qui a été vendu moins ce qui en reste dû — mais borné
     par ce qui reste vendable.
     
     Un retour éteint la dette sans qu'un franc ne rentre : le reste tombe,
     et l'encaissé, qui se déduit de lui, monterait d'autant. L'écran
     annoncerait un encaissement que personne n'a fait. On le plafonne donc
     à ce qui n'a pas été rendu, exactement comme la carte partenaire borne
     le versé. */
  const encaisse = Math.min(
    Math.max(0, totalVentes - resteAEncaisser),
    Math.max(0, totalVentes - totalRetours));

  /* Découpage de l'axe des abscisses selon la période choisie.
   *
   * Les retours suivent les mêmes tranches que les ventes : deux
   * découpages différents mettraient un retour de mardi sous la vente de
   * mercredi, et la courbe rouge ne voudrait plus rien dire. */
  const somme = (liste: { montant: number }[]) =>
    liste.reduce((n, x) => n + x.montant, 0);

  const serie = (() => {
    const now = new Date();
    if (periode === 'jour') {
      /* pas de granularité horaire sur les mouvements : on borne à la journée */
      return [{ label: "Aujourd'hui", a: totalVentes, b: totalBenefice,
                r: totalRetours }];
    }
    if (periode === 'semaine') {
      return JOURS.map((label, i) => {
        const d = new Date(debut);
        d.setDate(d.getDate() + i);
        const cle = iso(d);
        const jour = ventes.filter(v => v.date === cle);
        return { label, a: jour.reduce((s, v) => s + v.montant, 0), b: jour.reduce((s, v) => s + v.benefice, 0),
                 r: somme(retours.filter(x => x.date === cle)) };
      });
    }
    if (periode === 'mois') {
      return [0, 1, 2, 3].map(i => {
        const deb = new Date(debut); deb.setDate(1 + i * 7);
        const fin = new Date(debut); fin.setDate(1 + (i + 1) * 7);
        const bloc = ventes.filter(v => v.date >= iso(deb) && v.date < iso(fin));
        return { label: `S${i + 1}`, a: bloc.reduce((s, v) => s + v.montant, 0), b: bloc.reduce((s, v) => s + v.benefice, 0),
                 r: somme(retours.filter(x => x.date >= iso(deb) && x.date < iso(fin))) };
      });
    }
    if (periode === 'annee') {
      return MOIS.map((label, i) => {
        const prefixe = `${now.getFullYear()}-${String(i + 1).padStart(2, '0')}`;
        const bloc = ventes.filter(v => (v.date ?? '').startsWith(prefixe));
        return { label, a: bloc.reduce((s, v) => s + v.montant, 0), b: bloc.reduce((s, v) => s + v.benefice, 0),
                 r: somme(retours.filter(x => (x.date ?? '').startsWith(prefixe))) };
      });
    }
    /* Une année où l'on n'a que rendu existe aussi : la lire des seules
       ventes la ferait disparaître de l'axe. */
    const annees = [...new Set([
      ...ventes.map(v => (v.date ?? '').slice(0, 4)),
      ...retours.map(r => (r.date ?? '').slice(0, 4)),
    ].filter(Boolean))].sort();
    return annees.map(an => {
      const bloc = ventes.filter(v => (v.date ?? '').startsWith(an));
      return { label: an, a: bloc.reduce((s, v) => s + v.montant, 0), b: bloc.reduce((s, v) => s + v.benefice, 0),
               r: somme(retours.filter(x => (x.date ?? '').startsWith(an))) };
    });
  })();

  /* Les dépenses viennent du registre, pas d'un recalcul : une dépense est
     de l'argent sorti du tiroir, et seul le registre sait ce qui en est
     sorti. Les recalculer ailleurs donnait un second chiffre. */
  const sortiesCaisse = mouvementsCaisse.filter(
    m => m.sens === 'sortie' && dansPeriode(m.date) && !m.annuleParId && !m.annuleId);
  const totalDepenses = sortiesCaisse.reduce((s, m) => s + m.montant, 0);

  const partsDepenses = Object.entries(
    sortiesCaisse.reduce<Record<string, number>>((acc, m) => {
      const cle = LIBELLES_MOTIF_CAISSE[m.motif];
      acc[cle] = (acc[cle] ?? 0) + m.montant;
      return acc;
    }, {})
  ).map(([label, valeur]) => ({ label, valeur }));

  /* Ce que vaut un site sur la période : les sept chiffres de la carte
     d'ensemble, restreints à ses propres lignes. Le fonds vient de son
     registre, jamais d'un recalcul — c'est ce qu'il y a dans son tiroir. */
  function chiffresDuSite(id: string) {
    const v = ventesP.filter(x => x.siteId === id);
    const ventesS = v.reduce((n, x) => n + x.montant, 0);
    const beneficeS = v.reduce((n, x) => n + x.benefice, 0);
    const sol = soldesParSite[id] ?? { creance: 0, dette: 0 };
    /* Le même plafond que sur la vue d'ensemble : une créance éteinte par
       de la marchandise ne fait pas un encaissement. */
    const retoursS = retours
      .filter(r => r.siteId === id && dansPeriode(r.date))
      .reduce((n, r) => n + r.montant, 0);
    return {
      ventes: ventesS,
      benefice: beneficeS,
      retours: retoursS,
      /* Encaissé : ce qui a été vendu moins ce qui reste dû, borné par ce
         qui n'a pas été rendu. */
      encaisse: Math.min(
        Math.max(0, ventesS - sol.creance),
        Math.max(0, ventesS - retoursS)),
      creance: sol.creance,
      dette: sol.dette,
      fonds: soldeCaisse(mouvementsCaisse.filter(m => m.siteId === id)),
    };
  }

  return (
    /* Mise en page reprise du dashboard financier : la police, le dégradé
       de la carte Ventes, la courbe et l'anneau viennent de là. Seules les
       données changent — elles sont celles du site. */
    <div className={`${hankenGrotesk.className} flex flex-col gap-3`}>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className={titre
          ? 'text-xl font-bold text-neutral-900 dark:text-neutral-100'
          : 'text-sm font-bold text-neutral-900 dark:text-neutral-100'}>
          {titre ?? (vue === 'ensemble' ? "Vue d'ensemble" : 'Par site')}
        </p>
        <div className="flex items-center gap-2">
          {/* Le total cache ce que chaque site pèse : le second angle les
              remet côte à côte. Il n'a de sens qu'à plusieurs. */}
          {ctx.ensemble && (
            <div className="flex items-center rounded-xl bg-gray-100 p-1 dark:bg-gray-800">
              {([
                { cle: 'ensemble' as const, label: "Ensemble" },
                { cle: 'sites' as const, label: 'Par site' },
              ]).map(o => (
                <button key={o.cle} onClick={() => setVue(o.cle)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-bold transition-all ${vue === o.cle
                    ? 'bg-white text-indigo-600 shadow-sm dark:bg-gray-700 dark:text-indigo-400'
                    : 'text-gray-400 hover:text-gray-600'}`}>
                  {o.label}
                </button>
              ))}
            </div>
          )}
          {/* Dans un site, le filtre n'aurait qu'une valeur à proposer : il
              ne s'affiche que quand il y a un choix à faire. */}
          <FiltreSite sites={ctx.sites} valeur={ctx.filtre} onChange={ctx.setFiltre} />
          <PeriodFilter periode={periode} onChange={setPeriode} />
        </div>
      </div>

      {vue === 'sites' ? (
        /* Une carte par site : ce que chacun a vendu, gagné, encaissé, ce
           qu'il attend, ce qu'il doit et ce qu'il a en caisse. Le filtre
           s'applique ici aussi — choisir un site ne laisse que sa carte. */
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {ctx.sites
            .filter(st => !ctx.filtre || st.id === ctx.filtre)
            .map(st => {
              const c = chiffresDuSite(st.id);
              const marge = c.ventes > 0 ? Math.round((c.benefice / c.ventes) * 100) : 0;
              /* Ce qui est rentré sur ce qui a été vendu : la barre le montre
                 sans qu'on ait à diviser deux nombres de tête. */
              const taux = c.ventes > 0 ? Math.round((c.encaisse / c.ventes) * 100) : 0;
              /* Rien vendu, rien dû, rien en caisse : le dire vaut mieux que
                 six zéros alignés qu'il faut lire pour comprendre. */
              const dort = c.ventes === 0 && c.creance === 0
                && c.dette === 0 && c.fonds === 0 && c.retours === 0;

              return (
                /* La carte dit d'où l'on vient : la fiche du site rend
                   alors la flèche à la vue par site, pas à la liste. */
                <button key={st.id} type="button"
                  onClick={() => router.push(`/site/${st.id}?onglet=dashboard&de=ensemble`)}
                  className="group flex flex-col rounded-2xl border border-gray-100 bg-white p-5 text-left shadow-sm transition-all hover:border-indigo-200 hover:shadow-md dark:border-gray-800 dark:bg-gray-900 dark:hover:border-indigo-800/60">

                  {/* Le nom et la marge : de quoi on parle, et si ça paie. */}
                  <div className="mb-4 flex items-start justify-between gap-2">
                    <p className="min-w-0 flex-1 truncate text-sm font-bold text-gray-900 dark:text-gray-100">
                      {st.nom}
                    </p>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ${marge > 0
                      ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                      : marge < 0
                        ? 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400'
                        : 'bg-gray-100 text-gray-400 dark:bg-gray-800'}`}>
                      {marge > 0 ? '+' : ''}{marge} %
                    </span>
                  </div>

                  {dort ? (
                    <p className="py-6 text-center text-xs text-gray-300 dark:text-gray-600">
                      Aucune activité sur la période
                    </p>
                  ) : (
                    <>
                      {/* Ce qui est entré : la vente, et ce qu'elle a laissé. */}
                      <p className="text-[11px] font-medium uppercase tracking-wide text-gray-400">
                        Ventes
                      </p>
                      <p className="text-2xl font-bold leading-tight text-gray-900 dark:text-gray-100">
                        {formatMontant(c.ventes)}
                      </p>
                      <p className="mt-0.5 text-xs text-gray-400">
                        Bénéfice{' '}
                        <span className={c.benefice > 0 ? 'font-bold text-green-600'
                          : c.benefice < 0 ? 'font-bold text-red-500' : 'font-bold text-gray-400'}>
                          {formatMontant(c.benefice)}
                        </span>
                      </p>

                      {/* Encaissé contre vendu : la part rentrée se voit,
                          le reste dû est ce qui manque à la barre. */}
                      <div className="mt-4">
                        <div className="mb-1.5 flex items-baseline justify-between gap-2 text-xs">
                          <span className="text-gray-400">
                            Encaissé
                            {/* Le retour explique un encaissé plus bas que
                                le vendu : sans lui, l'écart n'a pas de nom. */}
                            {c.retours > 0 && (
                              <span className="ml-1 font-semibold text-red-500">
                                · Retours {formatMontant(c.retours)}
                              </span>
                            )}
                          </span>
                          <span className="font-bold text-gray-900 dark:text-gray-100">
                            {formatMontant(c.encaisse)}
                            <span className="ml-1 font-medium text-gray-400">{taux} %</span>
                          </span>
                        </div>
                        <div className="h-1.5 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
                          <div className="h-full rounded-full bg-indigo-500 transition-all"
                            style={{ width: `${Math.min(100, taux)}%` }} />
                        </div>
                      </div>

                      {/* Ce qu'on attend, ce qu'on doit, ce qu'on a. Trois
                          colonnes : l'argent à venir, l'argent qui partira,
                          l'argent présent. */}
                      <div className="mt-4 grid grid-cols-3 gap-2 border-t border-gray-100 pt-3 dark:border-gray-800">
                        {([
                          { label: 'Créance', valeur: c.creance,
                            ton: c.creance > 0 ? 'text-orange-500' : 'text-gray-300 dark:text-gray-600' },
                          { label: 'Dettes', valeur: c.dette,
                            ton: c.dette > 0 ? 'text-red-500' : 'text-gray-300 dark:text-gray-600' },
                          { label: 'Fonds', valeur: c.fonds,
                            ton: c.fonds < 0 ? 'text-red-500'
                              : c.fonds > 0 ? 'text-gray-900 dark:text-gray-100'
                              : 'text-gray-300 dark:text-gray-600' },
                        ]).map(x => (
                          <div key={x.label} className="min-w-0">
                            <p className="truncate text-[11px] text-gray-400">{x.label}</p>
                            <p className={`truncate text-xs font-bold ${x.ton}`}>
                              {formatMontant(x.valeur)}
                            </p>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </button>
              );
            })}
        </div>
      ) : (
      <>
      <VentesCard
        ventes={totalVentes}
        benefice={totalBenefice}
        encaisse={encaisse}
        reste={resteAEncaisser}
        retours={totalRetours}
        fonds={fonds}
        onNaviguer={onNaviguer}
      />

      {/* Ce qui attend le tiroir, en pleine largeur sous les trois cartes.
          Elle ne paraît que lorsqu'il y a quelque chose à confirmer : une
          carte à zéro en permanence finirait par ne plus être lue, et
          c'est justement celle qu'il faut voir. */}
      {(() => {
        const t = totauxEnAttente(attente);
        if (t.nb === 0) return null;
        return (
          <button type="button"
            onClick={() => onNaviguer('fonds')}
            className="w-full rounded-2xl border border-amber-200 bg-amber-50/60 p-4 text-left transition-colors hover:bg-amber-50 dark:border-amber-900/40 dark:bg-amber-900/10 dark:hover:bg-amber-900/20">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-amber-600 dark:text-amber-400">
                  <Hourglass size={12} /> À confirmer
                </p>
                <p className="mt-0.5 text-[12px] text-gray-500 dark:text-gray-400">
                  {t.nb} mouvement{t.nb > 1 ? 's' : ''} déclaré{t.nb > 1 ? 's' : ''},
                  en attente du caissier.
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <div className="rounded-xl bg-white px-3 py-2 dark:bg-gray-900">
                  <p className="text-[10px] font-bold uppercase tracking-wide text-gray-400">
                    Entrées
                  </p>
                  <p className={`${hankenGrotesk.className} text-[17px] font-bold leading-6 text-green-600`}>
                    {formatMontant(t.entrees)}
                  </p>
                </div>
                <div className="rounded-xl bg-white px-3 py-2 dark:bg-gray-900">
                  <p className="text-[10px] font-bold uppercase tracking-wide text-gray-400">
                    Sorties
                  </p>
                  <p className={`${hankenGrotesk.className} text-[17px] font-bold leading-6 text-red-500`}>
                    {formatMontant(t.sorties)}
                  </p>
                </div>
              </div>
            </div>
          </button>
        );
      })()}

      {/* La courbe s'étire avec la place disponible : sur un grand écran elle
          poussait les deux cartes de droite hors de vue. Une hauteur bornée
          garde l'ensemble lisible d'un coup d'œil. */}
      <div className="grid min-h-0 grid-cols-1 gap-3 lg:grid-cols-[1.7fr_1fr]">
        <div className="min-h-[280px] max-h-[420px]">
          <VentesBeneficeChart donnees={serie.map(s => ({
            jour: s.label, ventes: s.a, benefice: s.b, retours: s.r,
          }))} />
        </div>
        <div className="grid min-h-0 max-h-[420px] grid-rows-2 gap-3">
          <div className="min-h-[136px]">
            <DepensesChart parts={partsDepenses} ventes={totalVentes} />
          </div>
          <div className="min-h-[136px]">
            <CreancesDettesCard creances={creance} dettes={dette} onNaviguer={onNaviguer} />
          </div>
        </div>
      </div>
      </>
      )}

    </div>
  );
}

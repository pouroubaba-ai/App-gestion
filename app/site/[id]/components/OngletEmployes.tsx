'use client';
import { useEffect, useState, useMemo } from 'react';
import {
  collection, query, where, getDocs, addDoc, serverTimestamp,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { formatMontant } from '@/lib/format';
import { hankenGrotesk } from './finance/font';
import { useRouter } from 'next/navigation';
import { Loader2, Search, ArrowUpDown, ArrowUp, ArrowDown, Users, X, Plus, Check, Trash2, Filter } from 'lucide-react';
import ModalAssignation, { type ConfigRem } from './ModalAssignation';
import { ChampRecherche } from '@/components/Champs';
import {
  useSites, FiltreSite, CelluleSite, type PropsPortee,
} from './ContexteSites';
import { lireParSite } from '@/lib/portee';

type Toggle = 'remuneration' | 'avance';
type Statut = 'tous' | 'solde' | 'partiel' | 'non_solde';
type ColTri = 'nom' | 'total' | 'verse' | 'reste';
type TriDir = 'asc' | 'desc';
type EtatEmploye = 'actif' | 'inactif' | 'conge' | 'suspendu';

/** Seuls 'actif' et 'inactif' sont proposés ; les autres restent pour afficher d'anciens enregistrements. */
const ETATS: { key: EtatEmploye; label: string; color: string }[] = [
  { key: 'actif',     label: 'Actif',     color: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' },
  { key: 'inactif',   label: 'Inactif',   color: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400' },
  { key: 'conge',     label: 'Congé',     color: 'bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400' },
  { key: 'suspendu',  label: 'Suspendu',  color: 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400' },
];

interface Employe {
  id: string;
  /* Un employé appartient à un site : c'est lui qui le rémunère. */
  siteId?: string;
  nom: string;
  fonction?: string;
  contact?: string;
  etat: EtatEmploye;
  remunerationConfiguree?: number; // salaire périodique défini dans la fiche
  totalRemuneration: number;
  verseRemuneration: number;
  resteRemuneration: number;
  totalAvance: number;
  verseAvance: number;
  resteAvance: number;
}

function statutDe(reste: number, verse: number): { label: string; color: string } {
  if (reste <= 0) return { label: 'Soldé', color: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' };
  if (verse > 0)  return { label: 'Partiel', color: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' };
  return { label: 'Non soldé', color: 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400' };
}

interface Props extends PropsPortee { userId: string }

export default function OngletEmployes({ siteId, userId, sites, titre }: Props) {
  const ctx = useSites(siteId, sites);
  const router = useRouter();
  const [employes, setEmployes] = useState<Employe[]>([]);
  const [loading, setLoading] = useState(true);

  const [modalOuvert, setModalOuvert] = useState(false);
  const [nomEdit, setNomEdit] = useState('');
  const [fonctionEdit, setFonctionEdit] = useState('');
  const [contactEdit, setContactEdit] = useState('');
  const [etatEdit, setEtatEdit] = useState<EtatEmploye>('actif');
  const [saving, setSaving] = useState(false);

  /* rémunération à l'ajout */
  type AssignTemp = { configId: string; nomConfig: string; valeur: number; intervalleJours: number; actif: boolean };
  const [configs, setConfigs] = useState<ConfigRem[]>([]);
  const [modalRem, setModalRem] = useState(false);
  const [assignsTemp, setAssignsTemp] = useState<AssignTemp[]>([]);
  const [modalAssignTemp, setModalAssignTemp] = useState(false);

  const [toggle, setToggle] = useState<Toggle>('remuneration');
  const [recherche, setRecherche] = useState('');
  const [filtreStatut, setFiltreStatut] = useState<Statut>('tous');
  const [filtreEtat, setFiltreEtat] = useState<EtatEmploye | 'tous'>('tous');
  const [colTri, setColTri] = useState<ColTri>('nom');
  const [triDir, setTriDir] = useState<TriDir>('asc');

  useEffect(() => { charger(); }, [ctx.portee]);

  async function charger() {
    setLoading(true);
    /* Un employé appartient au site qui l'emploie, pas au compte qui a
       saisi sa fiche : filtrer sur le `userId` du connecté datait du temps
       où un seul compte tenait toute l'activité. Depuis qu'un site a des
       membres, un gérant ne voyait plus aucun employé. */
    const [empSnap, remSnap, avSnap, assignSnap] = await Promise.all([
      lireParSite('employes', ctx.portee),
      lireParSite('employe_remunerations', ctx.portee),
      lireParSite('employe_avances', ctx.portee),
      lireParSite('employe_rem_assignations', ctx.portee),
    ]);

    /* valeur mensuelle des assignations actives, chaque config ramenée à 30j */
    const mensuelMap: Record<string, number> = {};
    assignSnap.forEach(d => {
      const data = d.data();
      if (!data.actif || !data.intervalleJours) return;
      mensuelMap[data.employeId] = (mensuelMap[data.employeId] ?? 0) + (data.valeur / data.intervalleJours) * 30;
    });

    const remMap: Record<string, { total: number; verse: number }> = {};
    remSnap.forEach(d => {
      const data = d.data();
      const prev = remMap[data.employeId] ?? { total: 0, verse: 0 };
      remMap[data.employeId] = { total: prev.total + (data.montant ?? 0), verse: prev.verse + (data.verse ?? 0) };
    });

    const avMap: Record<string, { total: number; verse: number }> = {};
    avSnap.forEach(d => {
      const data = d.data();
      const prev = avMap[data.employeId] ?? { total: 0, verse: 0 };
      avMap[data.employeId] = { total: prev.total + (data.montant ?? 0), verse: prev.verse + (data.verse ?? 0) };
    });

    const liste: Employe[] = empSnap.map(d => {
      const data = d.data();
      const rem = remMap[d.id] ?? { total: 0, verse: 0 };
      const av  = avMap[d.id]  ?? { total: 0, verse: 0 };
      return {
        id: d.id,
        siteId: data.siteId,
        nom: data.nom,
        fonction: data.fonction ?? '',
        contact: data.contact ?? '',
        etat: (data.etat ?? 'actif') as EtatEmploye,
        remunerationConfiguree: mensuelMap[d.id] !== undefined ? Math.round(mensuelMap[d.id]) : undefined,
        totalRemuneration: rem.total,
        verseRemuneration: rem.verse,
        resteRemuneration: Math.max(rem.total - rem.verse, 0),
        totalAvance: av.total,
        verseAvance: av.verse,
        resteAvance: Math.max(av.total - av.verse, 0),
      };
    });

    setEmployes(liste);
    setLoading(false);
  }

  async function ouvrirModal() {
    setNomEdit(''); setFonctionEdit(''); setContactEdit(''); setEtatEdit('actif');
    setAssignsTemp([]);
    setModalAssignTemp(false);
    const snap = await lireParSite('employe_rem_configs', ctx.siteEcriture ?? ctx.portee);
    setConfigs(snap.map(d => ({ id: d.id, ...(d.data() as any) })));
    setModalOuvert(true);
  }

  async function ajouterEmploye() {
    if (!nomEdit.trim()) return;
    /* Un employé est embauché par un site : il faut savoir lequel. */
    const site = ctx.siteEcriture;
    if (!site) return;
    setSaving(true);
    const today = new Date().toISOString().split('T')[0];
    const ref = await addDoc(collection(db, 'employes'), {
      siteId: site, userId,
      nom: nomEdit.trim(),
      fonction: fonctionEdit.trim(),
      contact: contactEdit.trim(),
      etat: etatEdit,
      createdAt: serverTimestamp(),
    });
    for (const a of assignsTemp) {
      await addDoc(collection(db, 'employe_rem_assignations'), {
        employeId: ref.id, siteId: site, userId,
        configId: a.configId, nomConfig: a.nomConfig,
        valeur: a.valeur, intervalleJours: a.intervalleJours,
        dateDebut: today, actif: a.actif,
        createdAt: serverTimestamp(),
      });
    }
    /* On relit plutôt que de recopier.
     *
     * La ligne était fabriquée ici avec des zéros, alors qu'une
     * assignation active fait naître aussitôt une première rémunération :
     * la liste annonçait « Total 0 · Soldé » pendant que la fiche du même
     * employé affichait 100 000 à verser. Deux façons de connaître la
     * même chose finissent toujours par se contredire. */
    await charger();
    setSaving(false);
    setModalOuvert(false);
  }

  function toggleTri(col: ColTri) {
    if (colTri === col) setTriDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setColTri(col); setTriDir('asc'); }
  }

  const lignes = useMemo(() => {
    let liste = employes.map(e => {
      const total = toggle === 'remuneration' ? e.totalRemuneration : e.totalAvance;
      const verse = toggle === 'remuneration' ? e.verseRemuneration : e.verseAvance;
      const reste = toggle === 'remuneration' ? e.resteRemuneration : e.resteAvance;
      return { ...e, total, verse, reste };
    });

    if (recherche.trim()) {
      const q = recherche.toLowerCase();
      liste = liste.filter(e => e.nom.toLowerCase().includes(q) || (e.contact ?? '').toLowerCase().includes(q));
    }

    if (filtreEtat !== 'tous') {
      liste = liste.filter(e => e.etat === filtreEtat);
    }

    if (filtreStatut !== 'tous') {
      liste = liste.filter(e => {
        const s = statutDe(e.reste, e.verse).label;
        if (filtreStatut === 'solde')    return s === 'Soldé';
        if (filtreStatut === 'partiel')  return s === 'Partiel';
        if (filtreStatut === 'non_solde') return s === 'Non soldé';
        return true;
      });
    }

    liste.sort((a, b) => {
      let cmp = 0;
      if (colTri === 'nom')   cmp = a.nom.localeCompare(b.nom);
      if (colTri === 'total') cmp = a.total - b.total;
      if (colTri === 'verse') cmp = a.verse - b.verse;
      if (colTri === 'reste') cmp = a.reste - b.reste;
      return triDir === 'asc' ? cmp : -cmp;
    });

    return liste;
  }, [employes, toggle, recherche, filtreStatut, filtreEtat, colTri, triDir]);

  /* totaux cartes */
  const totalRem  = employes.reduce((s, e) => s + e.totalRemuneration, 0);
  const verseRem  = employes.reduce((s, e) => s + e.verseRemuneration, 0);
  const resteRem  = employes.reduce((s, e) => s + e.resteRemuneration, 0);
  const totalAv   = employes.reduce((s, e) => s + e.totalAvance, 0);
  const verseAv   = employes.reduce((s, e) => s + e.verseAvance, 0);
  const resteAv   = employes.reduce((s, e) => s + e.resteAvance, 0);

  function IcôneTriCol({ col }: { col: ColTri }) {
    if (colTri !== col) return <ArrowUpDown size={12} className="text-gray-300" />;
    return triDir === 'asc' ? <ArrowUp size={12} className="text-indigo-400" /> : <ArrowDown size={12} className="text-indigo-400" />;
  }

  const FILTRES: { key: Statut; label: string }[] = [
    { key: 'tous',      label: 'Tous' },
    { key: 'non_solde', label: 'Non soldé' },
    { key: 'partiel',   label: 'Partiel' },
    { key: 'solde',     label: 'Soldé' },
  ];

  /* compteurs pour les filtres — calculés sur la base filtrée par étatOnly (sans filtre statut) */
  const baseParEtat = filtreEtat === 'tous' ? employes : employes.filter(e => e.etat === filtreEtat);
  const countStatut = (s: Statut) => {
    if (s === 'tous') return baseParEtat.length;
    return baseParEtat.filter(e => {
      const reste = toggle === 'remuneration' ? e.resteRemuneration : e.resteAvance;
      const verse = toggle === 'remuneration' ? e.verseRemuneration : e.verseAvance;
      const label = statutDe(reste, verse).label;
      if (s === 'solde')    return label === 'Soldé';
      if (s === 'partiel')  return label === 'Partiel';
      if (s === 'non_solde') return label === 'Non soldé';
      return false;
    }).length;
  };

  /* compteurs état — calculés sur la base filtrée par statut (sans filtre état) */
  const baseParStatut = employes.filter(e => {
    if (filtreStatut === 'tous') return true;
    const reste = toggle === 'remuneration' ? e.resteRemuneration : e.resteAvance;
    const verse = toggle === 'remuneration' ? e.verseRemuneration : e.verseAvance;
    const label = statutDe(reste, verse).label;
    if (filtreStatut === 'solde')    return label === 'Soldé';
    if (filtreStatut === 'partiel')  return label === 'Partiel';
    if (filtreStatut === 'non_solde') return label === 'Non soldé';
    return true;
  });
  const countEtat = (key: EtatEmploye | 'tous') =>
    key === 'tous' ? baseParStatut.length : baseParStatut.filter(e => e.etat === key).length;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <p className={titre
          ? 'text-xl font-bold text-gray-900 dark:text-gray-100'
          : 'hidden'}>{titre}</p>
        {/* Le filtre porte sur tout l'écran, cartes comprises : le poser sous
            elles laisserait croire qu'il ne touche que le tableau. */}
        {ctx.ensemble && (
          <FiltreSite sites={ctx.sites} valeur={ctx.filtre} onChange={ctx.setFiltre} />
        )}
      </div>

      {/* Cartes résumé */}
      {!loading && (
        <div className="mb-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="rounded-2xl border border-black/[0.06] bg-white p-5 shadow-sm dark:border-white/10 dark:bg-neutral-900">
              <div className="flex items-start justify-between gap-3">
                <span className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-neutral-100 text-lg dark:bg-neutral-800">
                  💰
                </span>
                <span className="shrink-0 rounded-lg bg-neutral-100 px-2.5 py-1 text-xs font-bold text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
                  Reste à verser
                </span>
              </div>
              <p className="mt-3 text-[11px] font-bold uppercase tracking-wide text-neutral-400">
                Rémunérations dues
              </p>
              <p className={`${hankenGrotesk.className} mt-0.5 text-[26px] font-bold leading-8 tracking-tight text-neutral-900 dark:text-white`}>
                {formatMontant(resteRem)}
              </p>
              <div className="mt-2.5 flex justify-between gap-2 border-t border-black/[0.06] pt-2 text-xs dark:border-white/10">
                  <span className="flex items-baseline gap-1.5">
                    <span className="text-neutral-400">Total</span>
                    <span className="font-bold text-neutral-900 dark:text-white">{formatMontant(totalRem)}</span>
                  </span>
                  <span className="flex items-baseline gap-1.5">
                    <span className="text-neutral-400">Versé</span>
                    <span className="font-bold text-green-600">{formatMontant(verseRem)}</span>
                  </span>
              </div>
            </div>
            <div className="rounded-2xl border border-black/[0.06] bg-white p-5 shadow-sm dark:border-white/10 dark:bg-neutral-900">
              <div className="flex items-start justify-between gap-3">
                <span className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-neutral-100 text-lg dark:bg-neutral-800">
                  💳
                </span>
                <span className="shrink-0 rounded-lg bg-neutral-100 px-2.5 py-1 text-xs font-bold text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
                  À rembourser
                </span>
              </div>
              <p className="mt-3 text-[11px] font-bold uppercase tracking-wide text-neutral-400">
                Avances dues
              </p>
              <p className={`${hankenGrotesk.className} mt-0.5 text-[26px] font-bold leading-8 tracking-tight text-neutral-900 dark:text-white`}>
                {formatMontant(resteAv)}
              </p>
              <div className="mt-2.5 flex justify-between gap-2 border-t border-black/[0.06] pt-2 text-xs dark:border-white/10">
                  <span className="flex items-baseline gap-1.5">
                    <span className="text-neutral-400">Total</span>
                    <span className="font-bold text-neutral-900 dark:text-white">{formatMontant(totalAv)}</span>
                  </span>
                  <span className="flex items-baseline gap-1.5">
                    <span className="text-neutral-400">Versé</span>
                    <span className="font-bold text-green-600">{formatMontant(verseAv)}</span>
                  </span>
              </div>
            </div>
        </div>
      )}

      {/* Toggle */}
      <div className="flex items-center bg-gray-100 dark:bg-gray-800 rounded-xl p-1 mb-4">
        {(['remuneration', 'avance'] as Toggle[]).map(t => (
          <button key={t} onClick={() => setToggle(t)}
            className={`flex-1 py-2 rounded-lg text-sm font-medium transition-all
              ${toggle === t ? 'bg-white dark:bg-gray-700 text-indigo-600 dark:text-indigo-400 shadow-sm' : 'text-gray-400 dark:text-gray-500'}`}>
            {t === 'remuneration' ? 'Rémunération' : 'Avance'}
          </button>
        ))}
      </div>

      <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 shadow-sm p-5">

      {/* La recherche porte sur ce tableau : la laisser dehors la faisait
          passer pour un filtre de la page entière. */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="relative flex-1 min-w-40">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <ChampRecherche placeholder="Rechercher un employé…" valeur={recherche} onChange={setRecherche} className="w-full" />
        </div>
        {/* Le même groupe gris que les autres onglets : un filtre se lit
            pareil d'un écran à l'autre. */}
        <div className="flex items-center bg-gray-100 dark:bg-gray-800 rounded-xl p-1 gap-0.5 shrink-0">
          <Filter size={13} className="text-gray-400 ml-1 mr-0.5" />
          {FILTRES.map(f => (
            <button key={f.key} onClick={() => setFiltreStatut(f.key)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all
                ${filtreStatut === f.key
                  ? 'bg-white dark:bg-gray-700 text-indigo-600 dark:text-indigo-400 shadow-sm'
                  : 'text-gray-400 dark:text-gray-500 hover:text-gray-600'}`}>
              {f.label} ({countStatut(f.key)})
            </button>
          ))}
        </div>
        {/* Un employé est embauché par un site : sans site désigné, le
            formulaire s'ouvrait, se remplissait, et l'enregistrement ne
            faisait rien — un travail perdu sans explication. */}
        {ctx.siteEcriture && (
          <button onClick={ouvrirModal}
            className="flex items-center gap-1.5 px-3 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold rounded-xl transition-colors shrink-0">
            <Plus size={13} /> Ajouter
          </button>
        )}
      </div>

      {/* Filtres état */}
      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        <div className="flex items-center bg-gray-100 dark:bg-gray-800 rounded-xl p-1 gap-0.5">
          <span className="ml-1 mr-0.5 text-xs font-medium text-gray-400">État</span>
          <button onClick={() => setFiltreEtat('tous')}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all
              ${filtreEtat === 'tous'
                ? 'bg-white dark:bg-gray-700 text-indigo-600 dark:text-indigo-400 shadow-sm'
                : 'text-gray-400 dark:text-gray-500 hover:text-gray-600'}`}>
            Tous ({countEtat('tous')})
          </button>
          {ETATS.filter(et => et.key === 'actif' || et.key === 'inactif').map(et => (
            <button key={et.key} onClick={() => setFiltreEtat(et.key)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all
                ${filtreEtat === et.key
                  ? 'bg-white dark:bg-gray-700 text-indigo-600 dark:text-indigo-400 shadow-sm'
                  : 'text-gray-400 dark:text-gray-500 hover:text-gray-600'}`}>
              {et.label} ({countEtat(et.key)})
            </button>
          ))}
        </div>
      </div>

      {/* Tableau */}
      {loading
        ? <div className="flex justify-center py-16"><Loader2 size={24} className="animate-spin text-indigo-500" /></div>
        : lignes.length === 0
          ? (
            <div className="text-center py-16 text-gray-400">
              <Users size={36} className="mx-auto mb-3 opacity-20" />
              <p className="text-sm font-medium">Aucun employé trouvé</p>
            </div>
          )
          : (
            <>
            <p className="text-sm font-medium text-gray-500 mb-2">
              {lignes.length} employ{lignes.length > 1 ? 'és' : 'é'}
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm whitespace-nowrap">
                <thead>
                  <tr className="bg-indigo-600 text-white">
                    <th className="text-center px-4 py-3 font-medium">
                      <button onClick={() => toggleTri('nom')} className="flex items-center gap-1.5 hover:opacity-80">
                        Employé <IcôneTriCol col="nom" />
                      </button>
                    </th>
                    {ctx.ensemble && <th className="text-center px-4 py-3 font-medium">Site</th>}
                    <th className="text-center px-4 py-3 font-medium">Fonction</th>
                    <th className="text-center px-4 py-3 font-medium">Contact</th>
                    <th className="text-center px-4 py-3 font-medium">État</th>
                    <th className="text-center px-4 py-3 font-medium">Rémun. configurée</th>
                    <th className="text-center px-4 py-3 font-medium">
                      <button onClick={() => toggleTri('total')} className="flex items-center gap-1.5 hover:opacity-80">
                        {toggle === 'remuneration' ? 'Total rémunération' : 'Total avance'} <IcôneTriCol col="total" />
                      </button>
                    </th>
                    <th className="text-center px-4 py-3 font-medium">
                      <button onClick={() => toggleTri('verse')} className="flex items-center gap-1.5 hover:opacity-80">
                        Versé <IcôneTriCol col="verse" />
                      </button>
                    </th>
                    <th className="text-center px-4 py-3 font-medium">
                      <button onClick={() => toggleTri('reste')} className="flex items-center gap-1.5 hover:opacity-80">
                        Reste <IcôneTriCol col="reste" />
                      </button>
                    </th>
                    <th className="text-center px-4 py-3 font-medium">Statut</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                  {lignes.map(e => {
                    const s = statutDe(e.reste, e.verse);
                    return (
                      <tr key={e.id} onClick={() => router.push(
                        `/site/${e.siteId ?? ctx.siteEcriture}/employes/${e.id}${ctx.ensemble ? '?de=ensemble' : ''}`)} className="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors cursor-pointer">
                        <td className="px-4 py-3 font-medium text-gray-900 dark:text-gray-100 text-center">{e.nom}</td>
                        {ctx.ensemble && <CelluleSite nom={ctx.nomDe(e.siteId)} />}
                        <td className="px-4 py-3 text-gray-500 dark:text-gray-400 text-center">{e.fonction || '—'}</td>
                        <td className="px-4 py-3 text-gray-500 dark:text-gray-400 text-center">{e.contact || '—'}</td>
                        <td className="px-4 py-3 text-center">
                          {(() => { const et = ETATS.find(x => x.key === e.etat) ?? ETATS[0]; return <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${et.color}`}>{et.label}</span>; })()}
                        </td>
                        <td className="px-4 py-3 text-center">
                          {e.remunerationConfiguree !== undefined
                            ? <span className="font-medium text-gray-900 dark:text-gray-100">{formatMontant(e.remunerationConfiguree)}<span className="text-xs font-normal text-gray-400 ml-1">/ mois</span></span>
                            : <span className="text-gray-400 text-xs italic">Aucune</span>}
                        </td>
                        <td className="px-4 py-3 font-medium text-gray-900 dark:text-gray-100 text-center">{formatMontant(e.total)}</td>
                        <td className="px-4 py-3 text-green-600 font-medium text-center">{e.verse > 0 ? formatMontant(e.verse) : '—'}</td>
                        <td className="px-4 py-3 font-medium text-red-500 text-center">{formatMontant(e.reste)}</td>
                        <td className="px-4 py-3 text-center">
                          <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${s.color}`}>{s.label}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            </>
          )
      }
      </div>

      {/* Modal ajout employé */}
      {modalOuvert && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
          <div className="bg-white dark:bg-gray-900 rounded-2xl w-full max-w-sm shadow-xl p-5">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-base font-bold text-gray-900 dark:text-gray-100">Nouvel employé</h2>
              <button onClick={() => setModalOuvert(false)} className="text-gray-400 hover:text-gray-600 p-1"><X size={18} /></button>
            </div>

            <p className="text-xs font-bold text-gray-400 uppercase mb-1">Nom <span className="text-red-400">*</span></p>
            <input type="text" placeholder="Ex. Amadou Diallo" value={nomEdit} onChange={e => setNomEdit(e.target.value)}
              className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 mb-4 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />

            <p className="text-xs font-bold text-gray-400 uppercase mb-1">Fonction</p>
            <input type="text" placeholder="Ex. Caissier, Livreur…" value={fonctionEdit} onChange={e => setFonctionEdit(e.target.value)}
              className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 mb-4 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />

            <p className="text-xs font-bold text-gray-400 uppercase mb-1">Numéro / Contact</p>
            <input type="tel" placeholder="Ex. +221 77 000 00 00" value={contactEdit} onChange={e => setContactEdit(e.target.value)}
              className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 mb-4 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />


            <div className="flex items-center justify-between mb-4">
              <div>
                <p className="text-xs font-bold text-gray-400 uppercase">Rémunération</p>
                <p className="text-xs text-gray-400 mt-0.5">
                  {assignsTemp.length === 0
                    ? 'Non configurée'
                    : (() => {
                        const actifs = assignsTemp.filter(a => a.actif);
                        const valMois = actifs.reduce((s, a) => s + (a.valeur / a.intervalleJours) * 30, 0);
                        return `${formatMontant(Math.round(valMois))} / mois (${actifs.length} actif${actifs.length > 1 ? 's' : ''})`;
                      })()
                  }
                </p>
              </div>
              <button type="button" onClick={() => setModalRem(true)}
                className="px-3 py-1.5 text-xs font-bold text-indigo-600 border border-indigo-200 dark:border-indigo-800 rounded-xl hover:bg-indigo-50 dark:hover:bg-indigo-900/20 transition-colors">
                Configurer
              </button>
            </div>

            <p className="text-xs font-bold text-gray-400 uppercase mb-2">État</p>
            <div className="grid grid-cols-2 gap-2 mb-5">
              {ETATS.filter(et => et.key === 'actif' || et.key === 'inactif').map(et => (
                <button key={et.key} onClick={() => setEtatEdit(et.key)}
                  className={`py-2 rounded-xl border text-xs font-medium transition-all
                    ${etatEdit === et.key ? 'bg-indigo-50 dark:bg-indigo-900/30 border-indigo-400 text-indigo-700 dark:text-indigo-300' : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400'}`}>
                  {et.label}
                </button>
              ))}
            </div>

            <div className="flex gap-3">
              <button onClick={() => setModalOuvert(false)}
                className="flex-1 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-500">
                Annuler
              </button>
              <button onClick={ajouterEmploye} disabled={saving || !nomEdit.trim()}
                className="flex-1 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-bold flex items-center justify-center gap-2 transition-colors">
                {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Enregistrer
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal rémunérations configurées (tableau) */}
      {modalRem && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
          <div className="bg-white dark:bg-gray-900 rounded-2xl w-full max-w-lg shadow-xl p-5">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-base font-bold text-gray-900 dark:text-gray-100">Rémunérations configurées</h2>
              <div className="flex items-center gap-2">
                <button onClick={() => setModalAssignTemp(true)}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold rounded-xl transition-colors">
                  <Plus size={12} /> Assigner
                </button>
                <button onClick={() => setModalRem(false)} className="text-gray-400 hover:text-gray-600 p-1"><X size={18} /></button>
              </div>
            </div>
            {assignsTemp.length === 0
              ? <p className="text-xs text-gray-400 text-center py-6">Aucune configuration assignée</p>
              : (
                <div className="overflow-x-auto">
                  <p className="text-xs text-gray-400 mb-2">{assignsTemp.length} configuration{assignsTemp.length > 1 ? 's' : ''}</p>
                  <table className="w-full text-sm whitespace-nowrap">
                    <thead>
                      <tr className="bg-indigo-600 text-white">
                        <th className="text-center px-3 py-2.5 font-medium">Nom</th>
                        <th className="text-center px-3 py-2.5 font-medium">Valeur</th>
                        <th className="text-center px-3 py-2.5 font-medium">Intervalle</th>
                        <th className="text-center px-3 py-2.5 font-medium">État</th>
                        <th className="px-3 py-2.5 text-center"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                      {assignsTemp.map((a, i) => (
                        <tr key={i} className="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                          <td className="px-3 py-2.5 font-medium text-gray-900 dark:text-gray-100 text-center">{a.nomConfig}</td>
                          <td className="px-3 py-2.5 text-gray-600 dark:text-gray-400 text-center">{formatMontant(a.valeur)}</td>
                          <td className="px-3 py-2.5 text-gray-600 dark:text-gray-400 text-center">{a.intervalleJours}j</td>
                          <td className="px-3 py-2.5 text-center">
                            <span className={`px-2.5 py-1 rounded-full text-xs font-bold ${a.actif ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400'}`}>
                              {a.actif ? 'Actif' : 'Inactif'}
                            </span>
                          </td>
                          <td className="px-3 py-2.5 text-center">
                            <button onClick={() => setAssignsTemp(prev => prev.filter((_, j) => j !== i))}
                              className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors">
                              <Trash2 size={12} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            }
          </div>
        </div>
      )}

      {/* Assigner une rémunération engage une caisse : il faut la nommer. */}
      {modalAssignTemp && ctx.siteEcriture && (
        <ModalAssignation
          siteId={ctx.siteEcriture}
          userId={userId}
          configs={configs}
          dejaAssignesIds={assignsTemp.map(a => a.configId)}
          onClose={() => setModalAssignTemp(false)}
          onAssigner={({ configId, nomConfig, valeur, intervalleJours, actif }) => {
            setAssignsTemp(prev => [...prev, { configId, nomConfig, valeur, intervalleJours, actif }]);
            setModalAssignTemp(false);
          }}
          onConfigCree={c => setConfigs(prev => [...prev, c])}
          onConfigSupprime={id => setConfigs(prev => prev.filter(c => c.id !== id))}
        />
      )}
    </div>
  );
}

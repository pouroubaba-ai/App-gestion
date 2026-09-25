'use client';
import { useEffect, useState, useMemo } from 'react';
import {
  collection, query, where, getDocs, addDoc, serverTimestamp, getDoc, doc,
} from 'firebase/firestore';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { db, storage } from '@/lib/firebase';
import { sitesDuCompte } from '@/lib/roles';
import { chargesDesSites } from '@/lib/remuneration';
import { useAuth } from '@/lib/auth-context';
import AppLayout from '@/components/AppLayout';
import { formatMontant } from '@/lib/format';
import {
  Plus, MapPin, Users, BadgeCheck, ImagePlus, Loader2,
  Store, Warehouse, Search, SlidersHorizontal, ArrowUpDown, X,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { ChampRecherche } from '@/components/Champs';

type TypeSite = 'boutique' | 'depot';
type EtatSite = 'actif' | 'inactif';
type Tri = 'employes_desc' | 'employes_asc' | 'remuneration_desc' | 'remuneration_asc';

interface Site {
  id: string;
  nom: string;
  type: TypeSite;
  etat: EtatSite;
  adresse: string;
  imageUrl?: string;
  nbEmployes: number;
  remunerationMensuelle: number;
}

export default function SitePage() {
  const { user, activite, profile } = useAuth();
  const router = useRouter();
  const [sites, setSites] = useState<Site[]>([]);
  const [loading, setLoading] = useState(true);

  /* - Recherche / filtre / tri - */
  const [search, setSearch] = useState('');
  const [filtreType, setFiltreType] = useState<TypeSite | 'tout'>('tout');
  const [filtreEtat, setFiltreEtat] = useState<EtatSite | 'tout'>('tout');
  const [tri, setTri] = useState<Tri | ''>('');
  const [showFiltre, setShowFiltre] = useState(false);
  const [showTri, setShowTri] = useState(false);
  const [filtreTemp, setFiltreTemp] = useState<{ type: TypeSite | 'tout'; etat: EtatSite | 'tout' }>({ type: 'tout', etat: 'tout' });

  /* - Modal ajout - */
  const [showModal, setShowModal] = useState(false);
  const [nom, setNom] = useState('');
  const [type, setType] = useState<TypeSite>('boutique');
  const [adresse, setAdresse] = useState('');
  const [numero, setNumero] = useState('');
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [erreur, setErreur] = useState('');

  useEffect(() => {
    if (!user) return;
    if (!activite && profile?.role !== 'membre') return;
    fetchSites();
  }, [user, activite, profile?.role]);

  /* Un membre travaille sur un site, pas sur une liste : la traverser pour
     un seul élément n'apprend rien et demande un clic de plus. */
  useEffect(() => {
    if (loading || profile?.role !== 'membre') return;
    if (sites.length === 1) router.replace(`/site/${sites[0].id}`);
  }, [loading, profile?.role, sites, router]);

  async function fetchSites() {
    setLoading(true);
    try {
      /* Un membre n'a pas d'activité : il ne voit que les sites où un rôle
         l'attend. L'admin voit ceux de la sienne — les sites appartiennent
         à l'activité, pas au compte. */
      /* Les deux chiffres de la carte se déduisent des employés et de leurs
         configurations : les stocker sur le site les ferait diverger dès la
         première embauche. */
      async function avecCharges(liste: Site[]): Promise<Site[]> {
        const charges = await chargesDesSites(liste.map(s => s.id));
        return liste.map(s => ({ ...s, ...(charges[s.id] ?? {}) }));
      }

      if (!activite) {
        const ids = await sitesDuCompte(user!.uid);
        if (ids.length === 0) { setSites([]); return; }
        const docs = await Promise.all(ids.map(id => getDoc(doc(db, 'sites', id))));
        setSites(await avecCharges(
          docs.filter(d => d.exists()).map(d => ({ id: d.id, ...d.data() } as Site))));
        return;
      }

      const snap = await getDocs(query(
        collection(db, 'sites'),
        where('activiteId', '==', activite.id),
      ));
      setSites(await avecCharges(
        snap.docs.map(d => ({ id: d.id, ...d.data() } as Site))));
    } finally {
      setLoading(false);
    }
  }

  const sitesFiltres = useMemo(() => {
    let list = [...sites];
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(s => s.nom.toLowerCase().includes(q) || s.adresse.toLowerCase().includes(q));
    }
    if (filtreType !== 'tout') list = list.filter(s => s.type === filtreType);
    if (filtreEtat !== 'tout') list = list.filter(s => s.etat === filtreEtat);
    if (tri === 'employes_desc') list.sort((a, b) => b.nbEmployes - a.nbEmployes);
    if (tri === 'employes_asc') list.sort((a, b) => a.nbEmployes - b.nbEmployes);
    if (tri === 'remuneration_desc') list.sort((a, b) => b.remunerationMensuelle - a.remunerationMensuelle);
    if (tri === 'remuneration_asc') list.sort((a, b) => a.remunerationMensuelle - b.remunerationMensuelle);
    return list;
  }, [sites, search, filtreType, filtreEtat, tri]);

  const filtreActif = filtreType !== 'tout' || filtreEtat !== 'tout';

  function ouvrirModal() {
    setNom(''); setType('boutique'); setAdresse(''); setNumero('');
    setImageFile(null); setImagePreview(null); setErreur('');
    setShowModal(true);
  }

  function onImageChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImageFile(file);
    setImagePreview(URL.createObjectURL(file));
  }

  async function creerSite() {
    if (!nom.trim()) { setErreur('Nom requis.'); return; }
    if (!adresse.trim()) { setErreur('Adresse requise.'); return; }
    setSaving(true); setErreur('');
    try {
      let imageUrl = '';
      if (imageFile) {
        const storageRef = ref(storage, `sites/${user!.uid}/${Date.now()}_${imageFile.name}`);
        await uploadBytes(storageRef, imageFile);
        imageUrl = await getDownloadURL(storageRef);
      }
      await addDoc(collection(db, 'sites'), {
        activiteId: activite!.id,
        userId: user!.uid,
        nom: nom.trim(),
        numero: numero.trim(),
        type,
        etat: 'actif' as EtatSite,
        adresse: adresse.trim(),
        imageUrl,
        /* Ni `nbEmployes` ni `remunerationMensuelle` : ils se déduisent des
           employés du site et de leurs configurations. Stockés, ils
           divergeraient dès la première embauche. */
        createdAt: serverTimestamp(),
      });
      setShowModal(false);
      fetchSites();
    } catch (e: any) {
      setErreur(e?.message ?? 'Erreur lors de la création.');
    } finally {
      setSaving(false);
    }
  }

  const triLabels: Record<Tri, string> = {
    employes_desc: 'Employés ↓',
    employes_asc: 'Employés ↑',
    remuneration_desc: 'Rémunération ↓',
    remuneration_asc: 'Rémunération ↑',
  };

  return (
    <AppLayout>
      <div className="w-full mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">Sites</h1>
            <p className="text-sm text-gray-400 mt-0.5">{sitesFiltres.length} / {sites.length} site{sites.length > 1 ? 's' : ''}</p>
          </div>
          {/* Un membre travaille sur le site d'un autre : il n'en crée pas. */}
          {profile?.role !== 'membre' && (
            <button onClick={ouvrirModal}
              className="flex items-center gap-2 px-4 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-bold rounded-xl transition-colors">
              <Plus size={16} /> Nouveau site
            </button>
          )}
        </div>

        {/* Barre recherche + filtre + tri */}
        <div className="flex gap-2 mb-4 relative">
          {/* Recherche */}
          <div className="relative flex-1">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
            <ChampRecherche placeholder="Rechercher un site…" valeur={search} onChange={setSearch} className="w-full" />
            {search && (
              <button onClick={() => setSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                <X size={13} />
              </button>
            )}
          </div>

          {/* Filtre */}
          <button onClick={() => { setFiltreTemp({ type: filtreType, etat: filtreEtat }); setShowFiltre(true); }}
            className={`flex items-center gap-1.5 px-3 py-2.5 rounded-xl border text-sm font-medium transition-colors
              ${filtreActif
                ? 'bg-indigo-600 text-white border-indigo-600'
                : 'bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300'}`}>
            <SlidersHorizontal size={15} />
            <span className="hidden sm:inline">Filtre</span>
            {filtreActif && <span className="w-1.5 h-1.5 rounded-full bg-white" />}
          </button>

          {/* Tri */}
          <div className="relative">
            <button onClick={() => { setShowTri(v => !v); setShowFiltre(false); }}
              className={`flex items-center gap-1.5 px-3 py-2.5 rounded-xl border text-sm font-medium transition-colors
                ${tri
                  ? 'bg-indigo-600 text-white border-indigo-600'
                  : 'bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300'}`}>
              <ArrowUpDown size={15} />
              <span className="hidden sm:inline">Trier</span>
            </button>

            {showTri && (
              <div className="absolute right-0 top-12 z-20 bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-700 rounded-2xl shadow-xl p-2 w-52">
                {(Object.keys(triLabels) as Tri[]).map(t => (
                  <button key={t} onClick={() => { setTri(tri === t ? '' : t); setShowTri(false); }}
                    className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors
                      ${tri === t ? 'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-300 font-medium' : 'text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800'}`}>
                    {triLabels[t]}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Fermer dropdown tri en cliquant ailleurs */}
        {showTri && (
          <div className="fixed inset-0 z-10" onClick={() => setShowTri(false)} />
        )}

        {/* Liste */}
        {loading ? (
          <div className="flex justify-center py-20">
            <Loader2 size={28} className="animate-spin text-indigo-500" />
          </div>
        ) : sitesFiltres.length === 0 ? (
          <div className="text-center py-20 text-gray-400">
            <MapPin size={40} className="mx-auto mb-3 opacity-30" />
            <p className="font-medium">{sites.length === 0 ? 'Aucun site créé' : 'Aucun résultat'}</p>
            <p className="text-sm mt-1">{sites.length > 0 ? 'Modifiez vos filtres'
              : profile?.role === 'membre'
                ? 'Aucun site ne vous a été confié pour le moment'
                : 'Cliquez sur "Nouveau site" pour commencer'}</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {sitesFiltres.map(site => (
              <div key={site.id}
                className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 shadow-sm overflow-hidden flex flex-col">
                {/* Image */}
                <div className="h-40 bg-gray-100 dark:bg-gray-800 relative">
                  {site.imageUrl
                    ? <img src={site.imageUrl} alt={site.nom} className="w-full h-full object-cover" />
                    : <div className="w-full h-full flex items-center justify-center text-gray-300 dark:text-gray-600">
                        {site.type === 'boutique' ? <Store size={40} /> : <Warehouse size={40} />}
                      </div>
                  }
                  <div className="absolute top-2 left-2 flex gap-1.5">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-bold
                      ${site.type === 'boutique'
                        ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/50 dark:text-indigo-300'
                        : 'bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300'}`}>
                      {site.type === 'boutique' ? 'Boutique' : 'Dépôt'}
                    </span>
                    <span className={`px-2 py-0.5 rounded-full text-xs font-bold
                      ${site.etat === 'actif'
                        ? 'bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300'
                        : 'bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300'}`}>
                      {site.etat === 'actif' ? 'Actif' : 'Inactif'}
                    </span>
                  </div>
                </div>

                {/* Infos */}
                <div className="p-4 flex flex-col flex-1">
                  <p className="font-bold text-gray-900 dark:text-gray-100 text-base">{site.nom}</p>
                  <p className="text-xs text-gray-400 flex items-center gap-1 mt-1">
                    <MapPin size={11} /> {site.adresse}
                  </p>

                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <div className="bg-gray-50 dark:bg-gray-800 rounded-xl p-2.5">
                      <p className="text-xs text-gray-400 flex items-center gap-1"><Users size={11} /> Employés</p>
                      <p className="font-bold text-gray-900 dark:text-gray-100 mt-0.5">{site.nbEmployes}</p>
                    </div>
                    <div className="bg-gray-50 dark:bg-gray-800 rounded-xl p-2.5">
                      <p className="text-xs text-gray-400 flex items-center gap-1"><BadgeCheck size={11} /> Rémunération</p>
                      <p className="font-bold text-gray-900 dark:text-gray-100 mt-0.5 text-sm">
                        {formatMontant(site.remunerationMensuelle)}
                      </p>
                    </div>
                  </div>

                  <button
                    onClick={() => router.push(`/site/${site.id}`)}
                    className="mt-4 w-full py-2 rounded-xl border border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
                    Gérer le site
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Modal filtre */}
      {showFiltre && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 backdrop-blur-sm p-4">
          <div className="bg-white dark:bg-gray-900 rounded-2xl w-full max-w-sm shadow-xl p-5">
            <h2 className="text-base font-bold text-gray-900 dark:text-gray-100 mb-4">Filtrer</h2>

            <p className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase mb-2">Type</p>
            <div className="grid grid-cols-3 gap-2 mb-4">
              {(['tout', 'boutique', 'depot'] as const).map(t => (
                <button key={t} onClick={() => setFiltreTemp(prev => ({ ...prev, type: t }))}
                  className={`py-2 rounded-xl text-sm font-medium border transition-colors
                    ${filtreTemp.type === t
                      ? 'bg-indigo-600 text-white border-indigo-600'
                      : 'bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300'}`}>
                  {t === 'tout' ? 'Tout' : t === 'boutique' ? 'Boutique' : 'Dépôt'}
                </button>
              ))}
            </div>

            <p className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase mb-2">État</p>
            <div className="grid grid-cols-3 gap-2 mb-6">
              {(['tout', 'actif', 'inactif'] as const).map(e => (
                <button key={e} onClick={() => setFiltreTemp(prev => ({ ...prev, etat: e }))}
                  className={`py-2 rounded-xl text-sm font-medium border transition-colors
                    ${filtreTemp.etat === e
                      ? 'bg-indigo-600 text-white border-indigo-600'
                      : 'bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300'}`}>
                  {e === 'tout' ? 'Tout' : e === 'actif' ? 'Actif' : 'Inactif'}
                </button>
              ))}
            </div>

            <div className="flex gap-3">
              <button onClick={() => { setFiltreType('tout'); setFiltreEtat('tout'); setShowFiltre(false); }}
                className="flex-1 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-500 dark:text-gray-400">
                Réinitialiser
              </button>
              <button onClick={() => { setFiltreType(filtreTemp.type); setFiltreEtat(filtreTemp.etat); setShowFiltre(false); }}
                className="flex-1 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-bold transition-colors">
                Appliquer
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal création */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 backdrop-blur-sm p-4">
          <div className="bg-white dark:bg-gray-900 rounded-2xl w-full max-w-md shadow-xl p-5">
            <h2 className="text-base font-bold text-gray-900 dark:text-gray-100 mb-4">Nouveau site</h2>

            <label className="block mb-4 cursor-pointer">
              <div className={`h-32 rounded-xl border-2 border-dashed flex flex-col items-center justify-center transition-colors
                ${imagePreview ? 'border-transparent p-0 overflow-hidden' : 'border-gray-200 dark:border-gray-700 hover:border-indigo-400'}`}>
                {imagePreview
                  ? <img src={imagePreview} alt="" className="w-full h-full object-cover rounded-xl" />
                  : <><ImagePlus size={24} className="text-gray-300 dark:text-gray-600 mb-1" /><p className="text-xs text-gray-400">Ajouter une photo</p></>
                }
              </div>
              <input type="file" accept="image/*" className="hidden" onChange={onImageChange} />
            </label>

            {/* Toggle type */}
            <div className="flex items-center justify-between bg-gray-100 dark:bg-gray-800 rounded-xl p-1 mb-3">
              {(['boutique', 'depot'] as TypeSite[]).map(t => (
                <button key={t} onClick={() => setType(t)}
                  className={`flex-1 py-1.5 rounded-lg text-sm font-medium transition-all
                    ${type === t
                      ? 'bg-white dark:bg-gray-700 text-indigo-600 dark:text-indigo-400 shadow-sm'
                      : 'text-gray-400 dark:text-gray-500'}`}>
                  {t === 'boutique' ? 'Boutique' : 'Dépôt'}
                </button>
              ))}
            </div>

            <input
              type="text" placeholder="Nom du site" value={nom}
              onChange={e => setNom(e.target.value)}
              className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 mb-3 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />

            <input
              type="text" placeholder="Adresse" value={adresse}
              onChange={e => setAdresse(e.target.value)}
              className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 mb-3 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />

            <input
              type="text" placeholder="Numéro de téléphone" value={numero}
              onChange={e => setNumero(e.target.value)}
              className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 mb-3 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />

            {erreur && <p className="text-red-500 text-xs mb-3">{erreur}</p>}

            <div className="flex gap-3">
              <button onClick={() => setShowModal(false)}
                className="flex-1 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-600 dark:text-gray-300">
                Annuler
              </button>
              <button onClick={creerSite} disabled={saving}
                className="flex-1 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-sm font-bold flex items-center justify-center gap-2 transition-colors">
                {saving ? <><Loader2 size={15} className="animate-spin" /> Création…</> : 'Créer'}
              </button>
            </div>
          </div>
        </div>
      )}
    </AppLayout>
  );
}

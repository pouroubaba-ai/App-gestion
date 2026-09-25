'use client';

/**
 * Renommer les membres : {siteId}_{uid}.
 *
 * Les membres avaient des identifiants automatiques. Une règle Firestore
 * ne requête pas — elle lit un document dont elle connaît le chemin — et
 * ne pouvait donc pas répondre à « sur quel site travaille ce compte ? ».
 * Le site restait invisible au serveur, qui ne pouvait empêcher personne
 * d'écrire sur la boutique d'à côté.
 *
 * Sous leur nouveau nom, la question se résout par une simple lecture.
 *
 * Page de passage : elle sert une fois, avant la mise en ligne. Les
 * membres déjà bien nommés sont laissés tranquilles, et ceux qui
 * n'ont pas encore de compte restent des invitations — leur nom
 * définitif se posera à leur première connexion.
 */

import { useEffect, useState } from 'react';
import {
  collection, getDocs, doc, setDoc, deleteDoc,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useAuth } from '@/lib/auth-context';
import { Loader2, ArrowRight, Check, AlertTriangle } from 'lucide-react';

interface Ligne {
  id: string;
  cible: string;
  nom: string;
  email: string;
  role: string;
  siteId: string;
  compteUid: string | null;
  etat: 'a_faire' | 'deja' | 'invitation' | 'fait' | 'erreur';
  message?: string;
}

export default function MigrationMembres() {
  const { user, activite, loading: authLoading } = useAuth();
  const [lignes, setLignes] = useState<Ligne[]>([]);
  const [loading, setLoading] = useState(true);
  const [enCours, setEnCours] = useState(false);

  useEffect(() => {
    if (authLoading) return;
    getDocs(collection(db, 'membres'))
      .then(snap => {
        setLignes(snap.docs.map(d => {
          const m = d.data() as Record<string, unknown>;
          const siteId = (m.siteId as string) ?? '';
          const compteUid = (m.compteUid as string | null) ?? null;
          const cible = compteUid ? `${siteId}_${compteUid}` : '';
          return {
            id: d.id,
            cible,
            nom: (m.nom as string) ?? '—',
            email: (m.email as string) ?? '—',
            role: (m.role as string) ?? '—',
            siteId,
            compteUid,
            /* Sans compte, ce n'est pas encore un membre : c'est une
               invitation, qui prendra son nom à la première connexion. */
            etat: !compteUid ? 'invitation'
              : d.id === cible ? 'deja' : 'a_faire',
          } as Ligne;
        }));
      })
      .catch(() => setLignes([]))
      .finally(() => setLoading(false));
  }, [authLoading]);

  async function migrer() {
    setEnCours(true);
    for (const l of lignes) {
      if (l.etat !== 'a_faire') continue;
      try {
        const snap = await getDocs(collection(db, 'membres'));
        const source = snap.docs.find(d => d.id === l.id);
        if (!source) throw new Error('Document introuvable.');
        /* La copie d'abord, l'effacement ensuite : si la copie échoue,
           l'ancien reste et personne ne perd son accès. */
        await setDoc(doc(db, 'membres', l.cible), source.data());
        await deleteDoc(doc(db, 'membres', l.id));
        setLignes(x => x.map(y =>
          y.id === l.id ? { ...y, etat: 'fait' } : y));
      } catch (err) {
        setLignes(x => x.map(y => y.id === l.id
          ? {
              ...y, etat: 'erreur',
              message: err instanceof Error ? err.message : 'Échec.',
            }
          : y));
      }
    }
    setEnCours(false);
  }

  if (authLoading || loading) return (
    <div className="flex min-h-screen items-center justify-center">
      <Loader2 size={24} className="animate-spin text-indigo-500" />
    </div>
  );

  if (!user) return (
    <p className="p-10 text-center text-sm text-gray-500">
      Connectez-vous d’abord.
    </p>
  );

  const aFaire = lignes.filter(l => l.etat === 'a_faire').length;
  const faits = lignes.filter(l => l.etat === 'fait').length;
  const erreurs = lignes.filter(l => l.etat === 'erreur').length;

  return (
    <div className="mx-auto max-w-3xl p-6">
      <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">
        Renommer les membres
      </h1>
      <p className="mt-1 text-sm text-gray-500">
        Chaque membre prend le nom <code>{'{siteId}_{uid}'}</code>, pour que le
        serveur sache sur quel site il travaille.
      </p>

      {activite && (
        <p className="mt-1 text-xs text-gray-400">
          Activité : {activite.nom}
        </p>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button type="button" onClick={migrer}
          disabled={enCours || aFaire === 0}
          className="flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-bold text-white transition-colors hover:bg-indigo-700 disabled:opacity-40">
          {enCours ? <Loader2 size={15} className="animate-spin" /> : <ArrowRight size={15} />}
          {aFaire > 0 ? `Renommer ${aFaire} membre${aFaire > 1 ? 's' : ''}` : 'Rien à renommer'}
        </button>
        {faits > 0 && (
          <span className="flex items-center gap-1.5 text-sm font-bold text-green-600">
            <Check size={15} /> {faits} renommé{faits > 1 ? 's' : ''}
          </span>
        )}
        {erreurs > 0 && (
          <span className="flex items-center gap-1.5 text-sm font-bold text-red-500">
            <AlertTriangle size={15} /> {erreurs} en échec
          </span>
        )}
      </div>

      <div className="mt-5 space-y-2">
        {lignes.map(l => (
          <div key={l.id}
            className="rounded-xl border border-gray-100 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-bold text-gray-900 dark:text-gray-100">
                {l.nom} <span className="font-normal text-gray-400">· {l.role}</span>
              </span>
              <span className={`rounded-lg px-2 py-0.5 text-[11px] font-bold ${
                l.etat === 'fait' ? 'bg-green-100 text-green-700'
                  : l.etat === 'deja' ? 'bg-gray-100 text-gray-500'
                  : l.etat === 'invitation' ? 'bg-amber-100 text-amber-700'
                  : l.etat === 'erreur' ? 'bg-red-100 text-red-600'
                  : 'bg-indigo-100 text-indigo-700'}`}>
                {l.etat === 'fait' ? 'Renommé'
                  : l.etat === 'deja' ? 'Déjà au bon nom'
                  : l.etat === 'invitation' ? 'Invitation — pas encore de compte'
                  : l.etat === 'erreur' ? 'Échec'
                  : 'À renommer'}
              </span>
            </div>
            <p className="mt-1 text-xs text-gray-400">{l.email}</p>
            <p className="mt-2 break-all font-mono text-[11px] text-gray-400">
              {l.id}
              {l.cible && l.etat !== 'deja' && (
                <> → <span className="text-indigo-500">{l.cible}</span></>
              )}
            </p>
            {l.message && (
              <p className="mt-1 text-[11px] font-medium text-red-500">{l.message}</p>
            )}
          </div>
        ))}
        {lignes.length === 0 && (
          <p className="py-10 text-center text-sm text-gray-400">
            Aucun membre.
          </p>
        )}
      </div>
    </div>
  );
}

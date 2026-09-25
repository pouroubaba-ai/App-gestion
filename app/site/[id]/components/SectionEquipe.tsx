'use client';
import { useEffect, useState } from 'react';
import { Loader2, Plus, X, Check, UserPlus, Trash2 } from 'lucide-react';
import {
  membresDuSite, inviterMembre, changerRole, basculerMembre, retirerMembre,
  LIBELLES_ROLE, DESCRIPTIONS_ROLE, type Membre, type RoleSite,
} from '@/lib/roles';

/**
 * Qui travaille sur ce site.
 *
 * Le gérant distribue les rôles : c'est lui qui sait de qui il a besoin. On
 * invite par adresse, avant même que la personne ait un compte — elle le crée
 * elle-même, et son rôle l'attend à la première connexion.
 *
 * Un rôle se retire en désactivant le membre, pas en l'effaçant : l'archive
 * garde qui a fait quoi, et une ligne supprimée rendrait ses traces muettes.
 */

const ROLES: RoleSite[] = ['gerant', 'recouvrement', 'commandes', 'caissier'];

export default function SectionEquipe({
  siteId, activiteId,
}: {
  siteId: string;
  activiteId: string;
}) {
  const [membres, setMembres] = useState<Membre[]>([]);
  const [loading, setLoading] = useState(true);
  const [erreur, setErreur] = useState('');

  const [modal, setModal] = useState(false);
  const [nom, setNom] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<RoleSite>('commandes');
  const [saving, setSaving] = useState(false);
  const [aRetirer, setARetirer] = useState<Membre | null>(null);

  useEffect(() => { charger(); }, [siteId]);

  async function charger() {
    setLoading(true);
    try { setMembres(await membresDuSite(siteId)); }
    catch { setMembres([]); }
    finally { setLoading(false); }
  }

  async function inviter() {
    if (!nom.trim() || !email.trim()) return;
    setSaving(true); setErreur('');
    try {
      await inviterMembre({ siteId, activiteId, nom, email, role });
      await charger();
      setModal(false); setNom(''); setEmail(''); setRole('commandes');
    } catch (e: any) { setErreur(e?.message ?? 'Invitation impossible.'); }
    finally { setSaving(false); }
  }

  return (
    <div className="rounded-2xl border border-gray-100 bg-white p-5 dark:border-gray-800 dark:bg-gray-900">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm font-bold text-gray-900 dark:text-gray-100">
          Équipe du site
          {membres.length > 0 && (
            <span className="ml-2 font-medium text-gray-400">
              {membres.length} membre{membres.length > 1 ? 's' : ''}
            </span>
          )}
        </p>
        <button onClick={() => setModal(true)}
          className="flex shrink-0 items-center gap-1.5 rounded-xl bg-indigo-600 px-3 py-2 text-xs font-bold text-white transition-colors hover:bg-indigo-700">
          <Plus size={13} /> Ajouter
        </button>
      </div>

      {erreur && <p className="mb-3 text-xs text-red-500">{erreur}</p>}

      {loading ? (
        <div className="flex justify-center py-10">
          <Loader2 size={20} className="animate-spin text-indigo-500" />
        </div>
      ) : membres.length === 0 ? (
        <div className="py-10 text-center">
          <UserPlus size={32} className="mx-auto mb-3 text-gray-200 dark:text-gray-700" />
          <p className="text-sm font-medium text-gray-400">Personne d&apos;autre sur ce site</p>
          <p className="mt-1 text-xs text-gray-400">
            Chacun ne verra que ce que son rôle demande.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full whitespace-nowrap text-sm">
            <thead>
              <tr className="bg-indigo-600 text-white">
                <th className="px-3 py-2.5 text-center font-medium">Nom</th>
                <th className="px-3 py-2.5 text-center font-medium">Adresse</th>
                <th className="px-3 py-2.5 text-center font-medium">Rôle</th>
                <th className="px-3 py-2.5 text-center font-medium">Compte</th>
                <th className="px-3 py-2.5 text-center font-medium">État</th>
                <th className="px-3 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
              {membres.map(m => (
                <tr key={m.id} className={m.actif === false ? 'opacity-50' : ''}>
                  <td className="px-3 py-2.5 text-center font-medium text-gray-900 dark:text-gray-100">
                    {m.nom}
                  </td>
                  <td className="px-3 py-2.5 text-center text-gray-500">{m.email}</td>
                  <td className="px-3 py-2.5 text-center">
                    {/* Le rôle se change sans retirer : une personne qui passe
                        des commandes aux recouvrements reste la même. */}
                    <select value={m.role}
                      onChange={async e => {
                        await changerRole(m.id, e.target.value as RoleSite);
                        charger();
                      }}
                      className="rounded-lg border border-gray-200 bg-white px-2 py-1 text-xs font-bold text-gray-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200">
                      {ROLES.map(r => (
                        <option key={r} value={r}>{LIBELLES_ROLE[r]}</option>
                      ))}
                    </select>
                  </td>
                  <td className="px-3 py-2.5 text-center">
                    {/* Tant qu'elle ne s'est pas connectée, l'invitation
                        attend : le rôle se posera à sa première entrée. */}
                    {m.compteUid
                      ? <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-bold text-green-700 dark:bg-green-900/30 dark:text-green-400">Actif</span>
                      : <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">En attente</span>}
                  </td>
                  <td className="px-3 py-2.5 text-center">
                    <button onClick={async () => { await basculerMembre(m.id, m.actif === false); charger(); }}
                      className={`rounded-full px-2 py-0.5 text-xs font-bold transition-colors ${
                        m.actif === false
                          ? 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400'
                          : 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400'}`}>
                      {m.actif === false ? 'Suspendu' : 'En poste'}
                    </button>
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <button onClick={() => setARetirer(m)}
                      title="Retirer du site"
                      className="rounded-lg p-1.5 text-gray-300 transition-colors hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-900/20">
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Inviter : l'adresse suffit, le compte viendra. */}
      {modal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl dark:bg-gray-900">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-base font-bold text-gray-900 dark:text-gray-100">
                Ajouter au site
              </h2>
              <button onClick={() => setModal(false)} className="p-1 text-gray-400 hover:text-gray-600">
                <X size={18} />
              </button>
            </div>

            <p className="mb-1 text-xs font-bold uppercase text-gray-400">Nom</p>
            <input value={nom} onChange={e => setNom(e.target.value)}
              placeholder="Ex. Amadou Diallo"
              className="mb-3 w-full rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100" />

            <p className="mb-1 text-xs font-bold uppercase text-gray-400">Adresse</p>
            <input value={email} onChange={e => setEmail(e.target.value)}
              type="email" placeholder="Ex. amadou@exemple.com"
              className="mb-3 w-full rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100" />

            <p className="mb-1 text-xs font-bold uppercase text-gray-400">Rôle</p>
            {/* Quatre choix fixes : des boutons, pas une liste à chercher. */}
            <div className="mb-2 grid grid-cols-2 gap-2">
              {ROLES.map(r => (
                <button key={r} type="button" onClick={() => setRole(r)}
                  className={`rounded-xl border py-2.5 text-sm font-medium transition-all ${
                    role === r
                      ? 'border-indigo-400 bg-indigo-50 text-gray-900 dark:bg-indigo-900/30 dark:text-gray-100'
                      : 'border-gray-200 text-gray-900 dark:border-gray-700 dark:text-gray-100'}`}>
                  {LIBELLES_ROLE[r]}
                </button>
              ))}
            </div>
            {/* La description sous les boutons : dans la liste, elle écrasait
                les noms au point de les tronquer. */}
            <p className="mb-4 text-xs text-gray-400">{DESCRIPTIONS_ROLE[role]}</p>

            <div className="flex gap-3">
              <button onClick={() => setModal(false)}
                className="flex-1 rounded-xl border border-gray-200 py-2.5 text-sm font-medium text-gray-500 dark:border-gray-700">
                Annuler
              </button>
              <button onClick={inviter} disabled={saving || !nom.trim() || !email.trim()}
                className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-indigo-600 py-2.5 text-sm font-bold text-white transition-colors hover:bg-indigo-700 disabled:opacity-40">
                {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Ajouter
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Retirer efface le rôle, pas l'histoire : les écritures déjà signées
          gardent le nom de leur auteur. */}
      {aRetirer && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl dark:bg-gray-900">
            <p className="mb-2 text-base font-bold text-gray-900 dark:text-gray-100">
              Retirer {aRetirer.nom} ?
            </p>
            <p className="mb-4 text-xs text-gray-500">
              Son rôle disparaît, ce qu&apos;il a enregistré reste.
              Pour un départ provisoire, suspendez-le plutôt.
            </p>
            <div className="flex gap-3">
              <button onClick={() => setARetirer(null)}
                className="flex-1 rounded-xl border border-gray-200 py-2.5 text-sm font-medium text-gray-500 dark:border-gray-700">
                Annuler
              </button>
              <button onClick={async () => { await retirerMembre(aRetirer.id); setARetirer(null); charger(); }}
                className="flex-1 rounded-xl bg-red-600 py-2.5 text-sm font-bold text-white transition-colors hover:bg-red-700">
                Retirer
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

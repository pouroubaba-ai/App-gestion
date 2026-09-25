'use client';

/**
 * Le cycle entier, quand l'écran n'en montre qu'une partie.
 *
 * La rangée ne porte que les étapes où le geste est attendu : trois sur
 * sept pour qui fait avancer la marchandise. C'est ce qu'il faut pour
 * travailler, mais pas pour se repérer — un dossier qu'on a expédié la
 * veille sort de la rangée dès qu'il est reçu, et rien ne dit où il est
 * passé.
 *
 * Ce panneau répond à cette seule question : où en sont les dossiers, tous
 * états confondus. Les étapes qui ne sont pas du ressort de celui qui
 * regarde s'y lisent sans s'ouvrir — savoir n'est pas pouvoir agir.
 */

import { X, Lock } from 'lucide-react';

export interface EtapeVue {
  cle: string;
  label: string;
  emoji: string;
  n: number;
  /** Ouvrable, ou seulement consultable. */
  ouvrable: boolean;
}

interface Props {
  titre: string;
  etapes: EtapeVue[];
  /** L'étape ouverte, pour la désigner dans la liste. */
  courante: string;
  onChoisir: (cle: string) => void;
  onFermer: () => void;
}

export default function ModalEtapes({
  titre, etapes, courante, onChoisir, onFermer,
}: Props) {
  const bloquees = etapes.filter(e => !e.ouvrable).length;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 backdrop-blur-sm sm:items-center"
      onClick={onFermer}>
      {/* Sur un téléphone, le panneau monte du bas : c'est de là que vient
          le pouce, et la liste reste sous lui. */}
      <div onClick={e => e.stopPropagation()}
        className="max-h-[85vh] w-full overflow-y-auto rounded-t-3xl bg-white p-5 shadow-2xl dark:bg-gray-900 sm:max-w-md sm:rounded-3xl">

        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <p className="text-base font-bold text-gray-900 dark:text-gray-100">{titre}</p>
            <p className="mt-0.5 text-xs text-gray-400">
              {etapes.reduce((n, e) => n + e.n, 0)} dossier
              {etapes.reduce((n, e) => n + e.n, 0) > 1 ? 's' : ''} en tout
            </p>
          </div>
          <button onClick={onFermer} aria-label="Fermer"
            className="shrink-0 rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 dark:hover:bg-gray-800">
            <X size={18} />
          </button>
        </div>

        <div className="space-y-1.5">
          {etapes.map(e => {
            const active = e.cle === courante;
            return (
              <button key={e.cle} type="button"
                disabled={!e.ouvrable}
                onClick={() => { if (e.ouvrable) { onChoisir(e.cle); onFermer(); } }}
                className={`flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left transition-colors ${
                  active
                    ? 'bg-indigo-600 text-white'
                    : e.ouvrable
                      ? 'bg-gray-50 hover:bg-gray-100 dark:bg-gray-800/60 dark:hover:bg-gray-800'
                      /* Ni fond ni survol : rien ne se passera au clic, et
                         le laisser croire serait pire que de le dire. */
                      : 'cursor-default opacity-60'}`}>
                <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-lg ${
                  active ? 'bg-white/15' : 'bg-white dark:bg-gray-900'}`}>
                  {e.emoji}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={`block truncate text-sm font-bold ${
                    active ? 'text-white' : 'text-gray-900 dark:text-gray-100'}`}>
                    {e.label}
                  </span>
                  <span className={`block text-xs ${
                    active ? 'text-indigo-100' : 'text-gray-400'}`}>
                    {e.n} dossier{e.n > 1 ? 's' : ''}
                  </span>
                </span>
                {!e.ouvrable && <Lock size={13} className="shrink-0 text-gray-400" />}
              </button>
            );
          })}
        </div>

        {/* Dire pourquoi certaines lignes ne s'ouvrent pas : un cadenas sans
            explication passe pour une panne. */}
        {bloquees > 0 && (
          <p className="mt-4 border-t border-gray-100 pt-3 text-xs text-gray-400 dark:border-gray-800">
            Les étapes verrouillées ne relèvent pas de votre poste : vous
            voyez où en sont les dossiers, sans avoir à y intervenir.
          </p>
        )}
      </div>
    </div>
  );
}

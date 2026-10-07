'use client';
import { Save, Trash2, X } from 'lucide-react';

/**
 * Quitter une saisie commencée : on demande, on ne décide pas.
 *
 * « Annuler » fermait le document sans rien dire. Le brouillon restait
 * dans le navigateur, et personne ne le savait : on rouvrait l'écran
 * des jours plus tard devant une marchandise qu'on ne reconnaissait
 * plus, ou l'on refaisait une saisie qui attendait déjà.
 *
 * Trois sorties, parce qu'il y a trois intentions derrière le même
 * clic : je reviendrai finir, j'abandonne pour de bon, je me suis
 * trompé de bouton. Les confondre fait perdre du travail dans un cas,
 * et en laisse traîner dans l'autre.
 *
 * Elle ne s'ouvre que lorsqu'il y a quelque chose à perdre : un tiers
 * désigné et au moins une ligne de marchandise. En deçà, la question
 * n'aurait pas d'objet et ne ferait qu'un clic de plus.
 */
export default function ModalQuitterSaisie({
  ouvert, nomDocument, onGarder, onEffacer, onRester,
}: {
  ouvert: boolean;
  /** « cet achat », « ce devis »… tel qu'on le nomme à l'écran */
  nomDocument: string;
  onGarder: () => void;
  onEffacer: () => void;
  onRester: () => void;
}) {
  if (!ouvert) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      /* Cliquer à côté revient à se raviser : c'est le geste le moins
         engageant, donc celui qui ne détruit rien. */
      onClick={onRester}>
      <div onClick={e => e.stopPropagation()}
        className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl dark:bg-neutral-900">
        <p className="text-base font-bold text-gray-900 dark:text-gray-100">
          Quitter {nomDocument} ?
        </p>
        <p className="mt-1.5 text-sm text-gray-500">
          Rien n’est encore enregistré.
        </p>

        {/* Les trois sur une seule ligne, sans explication sous chacun :
            leur nom dit déjà ce qu'ils font, et les gloses allongeaient
            la fenêtre sans rien apprendre. Chacun porte ses bords — un
            bouton sans contour se lit comme du texte, et l'on hésite à
            cliquer là où rien ne paraît cliquable. */}
        <div className="mt-5 flex items-center justify-end gap-2">
          {/* Se raviser en premier dans le code, en dernier à l'œil :
              l'œil va à droite, et c'est là que doit tomber le geste qui
              ne détruit rien. */}
          <button onClick={onRester}
            className="flex shrink-0 items-center gap-1.5 rounded-xl border border-gray-200 px-3 py-2 text-sm font-bold text-gray-600 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800">
            <X size={15} /> Revenir
          </button>
          <button onClick={onEffacer}
            className="flex shrink-0 items-center gap-1.5 rounded-xl border border-red-200 px-3 py-2 text-sm font-bold text-red-600 transition-colors hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-900/20">
            <Trash2 size={15} /> Effacer
          </button>
          <button onClick={onGarder}
            className="flex shrink-0 items-center gap-1.5 rounded-xl bg-indigo-600 px-3 py-2 text-sm font-bold text-white transition-colors hover:bg-indigo-700">
            <Save size={15} /> Garder
          </button>
        </div>
      </div>
    </div>
  );
}

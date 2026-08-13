import { useState } from 'react';
import type { ApiPlanQuestion } from '../../shared/api-types.ts';
import { Button } from './ui/button.tsx';
import { Field, Input } from './ui/input.tsx';
import { OptionCard } from './ui/option-card.tsx';

// One question at a time, Back/Next-navigated, ending in a single Submit —
// replaces the old "every question visible, free text only" form. An
// unanswered question defaults to its `recommended` option (or '' when the
// question has no options) so Submit always sends one answer per question.
export function QuestionsCarousel({
  questions,
  onSubmit,
  submitting,
}: {
  questions: ApiPlanQuestion[];
  onSubmit: (answers: string[]) => void;
  submitting: boolean;
}) {
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<string[]>(() => questions.map((q) => q.recommended ?? ''));
  const question = questions[step];
  const answer = answers[step] ?? '';
  const setAnswer = (value: string) =>
    setAnswers((prev) => prev.map((a, i) => (i === step ? value : a)));
  const isLast = step === questions.length - 1;

  return (
    <div>
      <p className="mt-1 text-xs text-mute">
        Question {step + 1} of {questions.length}
      </p>
      {question.options && question.options.length > 0 ? (
        <div className="mt-3 flex flex-col gap-2">
          <p className="text-[0.85rem] text-ink">{question.text}</p>
          {question.options.map((option) => (
            <OptionCard
              key={option}
              selected={answer === option}
              recommended={option === question.recommended}
              onClick={() => setAnswer(option)}
            >
              {option}
            </OptionCard>
          ))}
          <Input
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder="Or type your own answer"
            className="mt-1"
          />
        </div>
      ) : (
        <Field label={question.text}>
          <Input
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder="Your answer"
          />
        </Field>
      )}

      <div className="mt-5 flex flex-col gap-2 sm:flex-row">
        <Button
          type="button"
          variant="secondary"
          disabled={step === 0}
          onClick={() => setStep((s) => s - 1)}
        >
          Back
        </Button>
        {isLast ? (
          <Button type="button" onClick={() => onSubmit(answers)} loading={submitting}>
            Submit answers
          </Button>
        ) : (
          <Button type="button" onClick={() => setStep((s) => s + 1)}>
            Next
          </Button>
        )}
      </div>
    </div>
  );
}

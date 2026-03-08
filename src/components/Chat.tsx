import * as React from 'react';
import { useRef, useState } from 'react';

import { askTutor, getPracticeProblems } from '@/api';
import { logEvent } from '@/api/logger';
import { Button } from '@/components/ui/button';
import { useNotebook } from '@/contexts/NotebookContext';
import { enhanceQuestion } from '@/utils/enhancedQuestionUtils';
import practicePatternsJson from '@/utils/practice_patterns.json';
import { chatgptOverride, tutorInstruction } from '@/utils/prompts';
import ChatMessageBox from './ChatMessageBox';
import ChatMessages from './ChatMessages';
import ChatPlaceholder from './ChatPlaceholder';
import ToggleMode from './ToggleMode';
import { type IMessage } from './types';

const PRACTICE_PATTERNS = practicePatternsJson.map(
  (pattern: string) => new RegExp(pattern, 'i')
);

const EXAM_PATTERNS = [
  /(?:start|begin|do|run)?\s*(?:an\s+)?exam\s*mode\s*(?:on|about|for)?\s+(.+)/i,
  /(?:give|show)\s+me\s+(?:an\s+)?exam\s+(?:question|problem)\s+(?:on|about|for)\s+(.+)/i,
  /exam\s+(?:question|problem)\s+(?:on|about|for)\s+(.+)/i
];

type PracticeProblem = Awaited<
  ReturnType<typeof getPracticeProblems>
>['problems'][number];

type ExamSession = {
  topic: string;
  problem: PracticeProblem;
  confidence?: string;
  stage: 'awaiting_confidence' | 'awaiting_submission';
};

const formatExamQuestion = (
  problem: PracticeProblem,
  topic: string
): string => {
  const lines: string[] = [];
  lines.push(`## Exam Mode: ${topic}`);
  lines.push(
    'You will get **one** question and then submit your answer for grading.'
  );
  lines.push('');
  lines.push('### Question');
  lines.push(problem.text || 'No question text available.');

  if (problem.choices && problem.choices.length > 0) {
    lines.push('');
    lines.push('### Choices');
    for (let i = 0; i < problem.choices.length; i++) {
      lines.push(`${i + 1}. ${problem.choices[i]}`);
    }
  }

  if (problem.source_url) {
    lines.push('');
    lines.push(`Source: [practice.dsc10.com](${problem.source_url})`);
  }

  lines.push('');
  lines.push(
    'Before solving: how confident are you (0-100%) that you can solve this correctly?'
  );

  return lines.join('\n');
};

const buildExamSubmissionPrompt = (
  session: ExamSession,
  studentAnswer: string
): string => {
  const choicesBlock =
    session.problem.choices && session.problem.choices.length > 0
      ? session.problem.choices
          .map((choice, index) => `${index + 1}. ${choice}`)
          .join('\n')
      : 'No multiple-choice options provided.';

  return [
    'You are a DSC 10 exam grader.',
    'Grade the student response to the question below, then provide the correct answer and a concise explanation.',
    'Output in Markdown with exactly these sections:',
    '## Result',
    '## Feedback',
    '## Correct Answer',
    '## Why',
    '',
    `Topic: ${session.topic}`,
    `Student confidence: ${session.confidence || 'Not provided'}`,
    '',
    'Question:',
    session.problem.text || 'No question text available.',
    '',
    'Choices:',
    choicesBlock,
    '',
    `Student answer:\n${studentAnswer}`
  ].join('\n');
};

export default function Chat() {
  const { notebookName, getNotebookJson, getNearestMarkdownCell } =
    useNotebook();
  const [messages, setMessages] = useState<IMessage[]>([]);
  const [conversationId, setConversationId] = useState<string | undefined>(
    undefined
  );
  const [isWaiting, setIsWaiting] = useState(false);
  const [shouldResetNext, setShouldResetNext] = useState(false);
  const [examSession, setExamSession] = useState<ExamSession | null>(null);
  const loggedNotebookJsonForConversationIdRef = useRef<string | undefined>(
    undefined
  );

  type FrontendPromptMode = 'tutor' | 'chatgpt' | 'none';
  const [mode, setMode] = useState<FrontendPromptMode>('tutor');

  const isPracticeRequest = (
    query: string
  ): { isPractice: boolean; topic?: string } => {
    for (const pattern of PRACTICE_PATTERNS) {
      const match = query.match(pattern);
      if (match && match[1]) {
        const topic = match[1].trim();
        if (topic.length > 2) {
          return { isPractice: true, topic };
        }
      }
    }

    return { isPractice: false };
  };

  const isExamRequest = (
    query: string
  ): { isExam: boolean; topic?: string } => {
    for (const pattern of EXAM_PATTERNS) {
      const match = query.match(pattern);
      if (match && match[1]) {
        const topic = match[1].trim();
        if (topic.length > 2) {
          return { isExam: true, topic };
        }
      }
    }

    return { isExam: false };
  };

  const handleMessageSubmit = async (text: string) => {
    setMessages(prev => [...prev, { author: 'user', text }]);
    setIsWaiting(true);
    try {
      if (examSession) {
        if (examSession.stage === 'awaiting_confidence') {
          setExamSession(prev =>
            prev
              ? {
                  ...prev,
                  confidence: text,
                  stage: 'awaiting_submission'
                }
              : prev
          );

          logEvent({
            event_type: 'exam_mode_confidence',
            payload: {
              confidence_text: text,
              topic_query: examSession.topic,
              notebook: notebookName,
              conversation_id: conversationId
            }
          });

          setMessages(prev => [
            ...prev,
            {
              author: 'tutor',
              text: 'Confidence recorded. Now solve the question and send your full answer in your next message. I will grade it and give the correct answer.'
            }
          ]);
          return;
        }

        const notebookJson = getNotebookJson();
        const gradingInstruction =
          'Always respond in Markdown. You are grading a DSC 10 exam response. Be strict but fair, and include the correct answer.';

        const tutorMessage = await askTutor({
          student_question: buildExamSubmissionPrompt(examSession, text),
          conversation_id: conversationId,
          notebook_json: notebookJson,
          prompt: gradingInstruction,
          prompt_mode: 'override',
          reset_conversation: shouldResetNext || undefined
        });

        if (shouldResetNext) {
          setShouldResetNext(false);
        }

        if (tutorMessage.conversation_id) {
          setConversationId(tutorMessage.conversation_id);
        }

        logEvent({
          event_type: 'exam_mode_graded',
          payload: {
            topic_query: examSession.topic,
            problem_id: examSession.problem.id,
            confidence_text: examSession.confidence,
            student_submission: text,
            grade_response: tutorMessage.tutor_response,
            notebook: notebookName,
            conversation_id: tutorMessage.conversation_id || conversationId
          }
        });

        setMessages(prev => [
          ...prev,
          { author: 'tutor', text: tutorMessage.tutor_response }
        ]);
        setExamSession(null);
        return;
      }

      const examCheck = isExamRequest(text);
      if (examCheck.isExam && examCheck.topic !== undefined) {
        const practiceResponse = await getPracticeProblems({
          topic_query: examCheck.topic
        });

        if (
          !practiceResponse.problems ||
          practiceResponse.problems.length === 0
        ) {
          setMessages(prev => [
            ...prev,
            {
              author: 'tutor',
              text: `I couldn't find an exam-style question for **${examCheck.topic}**. Try another topic.`
            }
          ]);
          return;
        }

        const selectedProblem =
          practiceResponse.problems[
            Math.floor(Math.random() * practiceResponse.problems.length)
          ];

        setExamSession({
          topic: examCheck.topic,
          problem: selectedProblem,
          stage: 'awaiting_confidence'
        });

        logEvent({
          event_type: 'exam_mode_started',
          payload: {
            topic_query: examCheck.topic,
            problem_id: selectedProblem.id,
            notebook: notebookName,
            conversation_id: conversationId
          }
        });

        setMessages(prev => [
          ...prev,
          {
            author: 'tutor',
            text: formatExamQuestion(selectedProblem, examCheck.topic as string)
          }
        ]);
        return;
      }

      const practiceCheck = isPracticeRequest(text);

      if (practiceCheck.isPractice && practiceCheck.topic) {
        const practiceResponse = await getPracticeProblems({
          topic_query: practiceCheck.topic
        });

        logEvent({
          event_type: 'practice_problems_request',
          payload: {
            original_query: text,
            topic_query: practiceCheck.topic,
            notebook: notebookName,
            problem_count: practiceResponse.count,
            formatted_response: practiceResponse.formatted_response
          }
        });

        setMessages(prev => [
          ...prev,
          { author: 'tutor', text: practiceResponse.formatted_response }
        ]);
        return;
      }

      const promptToSend =
        mode === 'tutor' ? tutorInstruction : chatgptOverride;

      const backendPromptMode =
        mode === 'tutor' ? 'append' : mode === 'chatgpt' ? 'override' : 'none';

      const nearestMarkdown = getNearestMarkdownCell();
      const enhancedQuestion = enhanceQuestion(text, nearestMarkdown);
      const notebookJson = getNotebookJson();

      logEvent({
        event_type: 'tutor_query',
        payload: {
          question: text,
          mode,
          conversation_id: conversationId,
          notebook: notebookName
        }
      });

      const tutorMessage = await askTutor({
        student_question: enhancedQuestion,
        conversation_id: conversationId,
        notebook_json: notebookJson,
        prompt: promptToSend,
        prompt_mode: backendPromptMode,
        reset_conversation: shouldResetNext || undefined
      });

      if (shouldResetNext) {
        setShouldResetNext(false);
      }

      if (tutorMessage.conversation_id) {
        setConversationId(tutorMessage.conversation_id);
      }

      logEvent({
        event_type: 'tutor_response',
        payload: {
          conversation_id: tutorMessage.conversation_id,
          response: tutorMessage.tutor_response,
          mode,
          notebook: notebookName
        }
      });

      const finalConversationId =
        tutorMessage.conversation_id || conversationId;

      const isFirstTurn =
        !!finalConversationId &&
        loggedNotebookJsonForConversationIdRef.current !== finalConversationId;

      const turnPayload: Record<string, unknown> = {
        student_message: text,
        tutor_response: tutorMessage.tutor_response,
        prompt_mode: backendPromptMode,
        toggle_mode: mode,
        timestamp: new Date().toISOString(),
        conversation_id: finalConversationId
      };

      if (isFirstTurn) {
        turnPayload.initial_notebook_json = notebookJson;
        loggedNotebookJsonForConversationIdRef.current = finalConversationId;
      }

      logEvent({
        event_type: 'tutor_notebook_info',
        payload: turnPayload
      });

      setMessages(prev => [
        ...prev,
        { author: 'tutor', text: tutorMessage.tutor_response }
      ]);
    } catch (error) {
      console.error('Error asking tutor:', error);
      const errorMessage =
        error instanceof Error
          ? error.message
          : 'An error occurred while contacting the tutor. Please try again.';
      setMessages(prev => [
        ...prev,
        { author: 'tutor', text: `Error: ${errorMessage}` }
      ]);
    } finally {
      setIsWaiting(false);
    }
  };

  const handleNewConversation = () => {
    setMessages([]);
    setConversationId(undefined);
    setIsWaiting(false);
    setExamSession(null);
    loggedNotebookJsonForConversationIdRef.current = undefined;

    setShouldResetNext(true);
  };

  if (!notebookName) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <ChatPlaceholder />
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col gap-2">
      <div className="flex items-center justify-between gap-0.5 px-1">
        <Button
          className="w-50 px-2 py-0.5 text-xs"
          onClick={handleNewConversation}
          disabled={isWaiting}
        >
          New Conversation
        </Button>
        <ToggleMode mode={mode} setMode={setMode} disabled={isWaiting} />
      </div>
      <ChatMessages messages={messages} isWaiting={isWaiting} />
      <ChatMessageBox onSubmit={handleMessageSubmit} disabled={isWaiting} />
    </div>
  );
}

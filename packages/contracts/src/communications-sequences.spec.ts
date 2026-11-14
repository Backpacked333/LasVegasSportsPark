import { describe, expect, it } from 'vitest';
import {
  CreateMessageTemplateBody,
  EditScheduledMessageBody,
  MESSAGE_ANCHORS_BY_SUBJECT,
  MESSAGE_PLACEHOLDERS,
  MESSAGE_PLACEHOLDER_NAMES,
  MessageAnchorSchema,
  ScheduledMessageStatusSchema,
  hasPlaceholderMarks,
  messagePlaceholderProblem,
  messagePlaceholdersIn,
  renderMessageText,
} from './api/communications-sequences';
import { ScheduledMessageMachine } from './state-machines';

describe('message templates and sequences contract (SPK-COMMS-009, proposed amendment PA-05)', () => {
  it('SPK-COMMS-009: placeholders are found by name, in order, once each', () => {
    expect(
      messagePlaceholdersIn(
        'Welcome to {{season_name}}. {{ season_name }} starts on {{start_date}} at {{field}}.',
      ),
    ).toEqual(['season_name', 'start_date', 'field']);
    expect(messagePlaceholdersIn('No placeholders here.')).toEqual([]);
  });

  it('SPK-COMMS-009: a placeholder with a value is filled; one without stays as written and is named, so it is never sent', () => {
    const rendered = renderMessageText(
      '{{season_name}} starts on {{first_game_date}} at {{field}}.',
      {
        season_name: 'Winter 2027',
        first_game_date: null,
        field: '',
      },
    );
    expect(rendered).toEqual({
      text: 'Winter 2027 starts on {{first_game_date}} at {{field}}.',
      missing: ['first_game_date', 'field'],
    });
    expect(hasPlaceholderMarks(rendered.text)).toBe(true);
    const filled = renderMessageText('{{season_name}} at {{ field }}', {
      season_name: 'Winter 2027',
      field: 'Field 2',
    });
    expect(filled).toEqual({ text: 'Winter 2027 at Field 2', missing: [] });
    expect(hasPlaceholderMarks(filled.text)).toBe(false);
  });

  it('SPK-COMMS-009: an unknown name or a stray pair of braces is a problem of the text', () => {
    expect(messagePlaceholderProblem('See you at {{field}}.')).toBeNull();
    expect(messagePlaceholderProblem('See you at {{feild}}.')).toMatch(/Unknown placeholder/);
    expect(messagePlaceholderProblem('See you at {{ field }.')).toMatch(/Double braces/);
    expect(messagePlaceholderProblem('A stray }} mark')).toMatch(/Double braces/);
    expect(messagePlaceholderProblem('Single {braces} are ordinary text.')).toBeNull();
  });

  it('SPK-COMMS-009: a template or an edited copy with an unknown placeholder is refused at the field', () => {
    const template = CreateMessageTemplateBody.safeParse({
      name: 'Welcome',
      category: 'operational',
      title: 'Welcome to {{seasn_name}}',
      body: 'See you on {{start_date}}.',
    });
    expect(template.success).toBe(false);
    expect(template.error?.issues.map((i) => i.path.join('.'))).toEqual(['title']);
    expect(
      EditScheduledMessageBody.safeParse({
        title: 'Title',
        body: 'At {{nowhere}}',
        expectedRevision: 1,
      }).success,
    ).toBe(false);
    // an edited copy is a title and a body, or neither (back to the template)
    expect(
      EditScheduledMessageBody.safeParse({ title: 'Title', body: null, expectedRevision: 1 })
        .success,
    ).toBe(false);
    expect(
      EditScheduledMessageBody.safeParse({ title: null, body: null, expectedRevision: 1 }).success,
    ).toBe(true);
    // request text: no control characters in a title, no NUL in a body
    expect(
      CreateMessageTemplateBody.safeParse({
        name: 'Welcome',
        category: 'operational',
        title: 'Line\nbreak',
        body: 'Body',
      }).success,
    ).toBe(false);
    expect(
      CreateMessageTemplateBody.safeParse({
        name: 'Welcome',
        category: 'operational',
        title: 'Title',
        body: 'Body\u0000',
      }).success,
    ).toBe(false);
  });

  it('SPK-COMMS-009: every placeholder names the records that fill it, and a first game anchors seasons only', () => {
    for (const name of MESSAGE_PLACEHOLDER_NAMES) {
      expect(MESSAGE_PLACEHOLDERS[name].subjects.length, name).toBeGreaterThan(0);
      expect(MESSAGE_PLACEHOLDERS[name].label.length, name).toBeGreaterThan(0);
    }
    expect(MESSAGE_ANCHORS_BY_SUBJECT.season).toEqual(MessageAnchorSchema.options);
    expect(MESSAGE_ANCHORS_BY_SUBJECT.offering).not.toContain('first_game');
  });

  it('SPK-COMMS-009: the published states are exactly the states of ScheduledMessageMachine', () => {
    expect(ScheduledMessageStatusSchema.options).toEqual(ScheduledMessageMachine.states);
  });
});

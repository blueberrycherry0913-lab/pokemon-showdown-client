/**
 * Battle choices
 *
 * PS will send requests "what do you do this turn?", and you send back
 * choices "I switch Pikachu for Caterpie, and Squirtle uses Water Gun"
 *
 * This file contains classes for handling requests and choices.
 *
 * Dependencies: battle-dex
 *
 * @author Guangcong Luo <guangcongluo@gmail.com>
 * @license MIT
 */

import type { Battle, ServerPokemon } from "./battle";
import { Dex, toID, type ID } from "./battle-dex";

export interface BattleRequestSideInfo {
	name: string;
	id: 'p1' | 'p2' | 'p3' | 'p4';
	pokemon: ServerPokemon[];
}
export interface BattleRequestAllyInfo {
	id: string;
	name: string;
	pokemon: ServerPokemon[];
}
export interface BattleRequestActivePokemon {
	moves: {
		name: string,
		id: ID,
		pp: number,
		maxpp: number,
		target: Dex.MoveTarget,
		disabled?: boolean,
	}[];
	maxMoves?: {
		name: string,
		id: ID,
		target: Dex.MoveTarget,
		disabled?: boolean,
	}[];
	zMoves?: ({
		name: string,
		id: ID,
		target: Dex.MoveTarget,
		disabled?: false,
	} | null)[];
	/** also true if the pokemon can Gigantamax */
	canDynamax?: boolean;
	/** if the pokemon can Gigantamax, a string containing the full name of its G-max move */
	gigantamax?: string;
	canMegaEvo?: boolean;
	canMegaEvoX?: boolean;
	canMegaEvoY?: boolean;
	canUltraBurst?: boolean;
	canTerastallize?: string;
	trapped?: boolean;
	maybeTrapped?: boolean;
	maybeDisabled?: boolean;
	maybeLocked?: boolean;
}

export interface BattleMoveRequest {
	requestType: 'move';
	rqid: number;
	side: BattleRequestSideInfo;
	ally?: BattleRequestAllyInfo;
	active: (BattleRequestActivePokemon | null)[];
	noCancel?: boolean;
	targetable?: boolean;
	/** Move data for Mind Controlled opponent Pokémon — this player chooses for them */
	controlledActive?: BattleRequestActivePokemon[];
	/** The side info of the opponent whose Pokémon are being controlled */
	controlledSide?: BattleRequestSideInfo;
}
export interface BattleSwitchRequest {
	requestType: 'switch';
	rqid: number;
	ally?: BattleRequestAllyInfo;
	side: BattleRequestSideInfo;
	forceSwitch: boolean[];
	noCancel?: boolean;
}
export interface BattleTeamRequest {
	requestType: 'team';
	rqid: number;
	side: BattleRequestSideInfo;
	ally?: BattleRequestAllyInfo;
	maxTeamSize?: number;
	maxChosenTeamSize?: number;
	chosenTeamSize?: number;
	noCancel?: boolean;
}
export interface BattleWaitRequest {
	requestType: 'wait';
	rqid: number;
	side: undefined;
	ally: undefined;
	noCancel?: boolean;
}
export type BattleRequest = BattleMoveRequest | BattleSwitchRequest | BattleTeamRequest | BattleWaitRequest;

interface BattleMoveChoice {
	choiceType: 'move';
	/** 1-based move */
	move: number;
	targetLoc: number;
	// gen 6
	mega: boolean;
	megax: boolean;
	megay: boolean;
	// gen 7
	z: boolean;
	ultra: boolean;
	// gen 8
	max: boolean;
	// gen 9
	tera: boolean;
	/** §11 Tera Crystal: the in-battle-chosen Tera type (canonical Name, e.g. "Fire"). */
	teraType?: string;
	telepathy: boolean;
}
interface BattleSwitchChoice {
	choiceType: 'switch' | 'team';
	/** 1-based pokemon */
	targetPokemon: number;
}
interface BattleMiscChoice {
	choiceType: 'shift' | 'testfight';
}
type BattleChoice = BattleMoveChoice | BattleSwitchChoice | BattleMiscChoice;

/**
 * Tracks a partial choice, allowing you to build it up one step at a time,
 * and maybe even construct a UI to build it!
 *
 * Doesn't support going backwards; just use `new BattleChoiceBuilder`.
 */
export class BattleChoiceBuilder {
	request: BattleRequest;
	noCancel: boolean;
	/** Completed choices in string form */
	choices: string[] = [];
	/** Currently active partial move choice - not used for other choices, which don't have partial states */
	current: BattleMoveChoice = {
		choiceType: 'move',
		/** if nonzero, show target screen; if zero, show move screen */
		move: 0,
		targetLoc: 0, // should always be 0: is not partial if `targetLoc` is known
		mega: false,
		megax: false,
		megay: false,
		ultra: false,
		z: false,
		max: false,
		tera: false,
		telepathy: false,
	};
	alreadySwitchingIn: number[] = [];
	alreadyMega = false;
	alreadyMax = false;
	alreadyZ = false;
	alreadyTera = false;
	/** Completed choices for Mind Controlled opponent Pokémon */
	controlledChoices: string[] = [];

	constructor(request: BattleRequest) {
		this.request = request;
		this.noCancel = request.noCancel || request.requestType === 'wait';
		this.fillPasses();
	}

	toString() {
		let choices = this.choices;
		if (this.current.move) choices = choices.concat(this.stringChoice(this.current));
		const allChoices = [...choices, ...this.controlledChoices];
		return allChoices.join(', ').replace(/, team /g, ', ');
	}

	isDone() {
		if (this.choices.length < this.requestLength()) return false;
		// Also wait for controlled Pokémon choices (Mind Controlled mechanic)
		const controlledActive = (this.request as BattleMoveRequest).controlledActive;
		if (controlledActive?.length) {
			return this.controlledChoices.length >= controlledActive.length;
		}
		return true;
	}

	/** Returns true once all controlled Pokémon choices have been made. */
	isControlledDone() {
		const controlledActive = (this.request as BattleMoveRequest).controlledActive;
		if (!controlledActive?.length) return true;
		return this.controlledChoices.length >= controlledActive.length;
	}
	isEmpty() {
		for (const choice of this.choices) {
			if (choice !== 'pass') return false;
		}
		if (this.current.move) return false;
		return true;
	}

	/** Index of the current Pokémon to make choices for */
	index(): number {
		return this.choices.length;
	}
	/** How many choices is the server expecting? */
	requestLength() {
		const request = this.request;
		switch (request.requestType) {
		case 'move':
			return request.active.length;
		case 'switch':
			return request.forceSwitch.length;
		case 'team':
			return request.chosenTeamSize || 1;
		case 'wait':
			return 0;
		}
	}
	currentMoveRequest(index = this.index()) {
		if (this.request.requestType !== 'move') return null;
		return this.request.active[index];
	}
	noMoreSwitchChoices() {
		if (this.request.requestType !== 'switch') return false;
		for (let i = this.requestLength(); i < this.request.side.pokemon.length; i++) {
			const pokemon = this.request.side.pokemon[i];
			if (!pokemon.fainted && !this.alreadySwitchingIn.includes(i + 1)) {
				return false;
			}
		}
		return true;
	}

	addChoice(choiceString: string) {
		// Handle controlled Pokémon choices (Mind Controlled mechanic)
		if (choiceString.startsWith('controlled ')) {
			const controlledActive = (this.request as BattleMoveRequest).controlledActive;
			if (!controlledActive?.length) return "No Mind Controlled Pokémon to control";
			if (this.controlledChoices.length >= controlledActive.length) {
				return "Already chose for all controlled Pokémon";
			}
			this.controlledChoices.push(choiceString);
			return null;
		}

		let choice: BattleChoice | null;
		try {
			choice = this.parseChoice(choiceString);
		} catch (err) {
			return (err as Error).message;
		}
		if (!choice) {
			return "You do not need to manually choose to pass; the client handles it for you automatically";
		}
		/** only the last choice can be uncancelable */
		const isLastChoice = this.choices.length + 1 >= this.requestLength();
		if (choice.choiceType === 'move') {
			if (!choice.targetLoc && (this.request as BattleMoveRequest).targetable) {
				const choosableTargets: unknown[] = ['normal', 'any', 'adjacentAlly', 'adjacentAllyOrSelf', 'adjacentFoe'];
				if (choosableTargets.includes(this.currentMove(choice)?.target)) {
					this.current = choice;
					return null;
				}
			}
			if (this.currentMoveRequest()?.maybeDisabled && isLastChoice) {
				this.noCancel = true;
			}
			if (choice.mega || choice.megax || choice.megay) this.alreadyMega = true;
			if (choice.z) this.alreadyZ = true;
			if (choice.max) this.alreadyMax = true;
			if (choice.tera) this.alreadyTera = true;
			this.current = {
				choiceType: 'move',
				move: 0,
				targetLoc: 0,
				mega: false,
				megax: false,
				megay: false,
				ultra: false,
				z: false,
				max: false,
				tera: false,
				telepathy: false,
			};
		} else if (choice.choiceType === 'switch' || choice.choiceType === 'team') {
			if (this.currentMoveRequest()?.trapped) {
				return "You are trapped and cannot switch out";
			}
			if (this.alreadySwitchingIn.includes(choice.targetPokemon)) {
				if (choice.choiceType === 'switch') {
					return "You've already chosen to switch that Pokémon in";
				}
				// remove choice instead
				for (let i = 0; i < this.alreadySwitchingIn.length; i++) {
					if (this.alreadySwitchingIn[i] === choice.targetPokemon) {
						this.alreadySwitchingIn.splice(i, 1);
						this.choices.splice(i, 1);
						return null;
					}
				}
				return "Unexpected bug, please report this";
			}
			if (this.currentMoveRequest()?.maybeTrapped && isLastChoice) {
				this.noCancel = true;
			}
			this.alreadySwitchingIn.push(choice.targetPokemon);
		} else if (choice.choiceType === 'testfight') {
			if (isLastChoice) {
				this.noCancel = true;
			}
		} else if (choice.choiceType === 'shift') {
			if (this.index() === 1) {
				return "Only Pokémon not already in the center can shift to the center";
			}
		}
		this.choices.push(this.stringChoice(choice));
		this.fillPasses();
		return null;
	}

	/**
	 * Move and switch requests will often skip over some active Pokémon (mainly
	 * fainted Pokémon). This will fill them in automatically, so we don't need
	 * to ask a user for them.
	 */
	fillPasses() {
		const request = this.request;
		switch (request.requestType) {
		case 'move':
			while (this.choices.length < request.active.length && !request.active[this.choices.length]) {
				this.choices.push('pass');
			}
			break;
		case 'switch':
			const noMoreSwitchChoices = this.noMoreSwitchChoices();
			while (this.choices.length < request.forceSwitch.length) {
				if (!request.forceSwitch[this.choices.length] || noMoreSwitchChoices) {
					this.choices.push('pass');
				} else {
					break;
				}
			}
		}
	}

	currentMove(choice = this.current, index = this.index()) {
		const moveIndex = choice.move - 1;
		return this.currentMoveList(index, choice)?.[moveIndex] || null;
	}

	currentMoveList(
		index = this.index(), current: { max?: boolean, z?: boolean } = this.current
	): ({ name: string, id: ID, target: Dex.MoveTarget, disabled?: boolean } | null)[] | null {
		const moveRequest = this.currentMoveRequest(index);
		if (!moveRequest) return null;
		if (current.max || (moveRequest.maxMoves && !moveRequest.canDynamax)) {
			return moveRequest.maxMoves || null;
		}
		if (current.z) {
			return moveRequest.zMoves || null;
		}
		return moveRequest.moves;
	}
	/**
	 * Parses a choice from string form to BattleChoice form
	 */
	parseChoice(choice: string, index = this.choices.length): BattleChoice | null {
		const request = this.request;
		if (request.requestType === 'wait') throw new Error(`It's not your turn to choose anything`);

		if (choice === 'shift' || choice === 'testfight') {
			if (request.requestType !== 'move') {
				throw new Error(`You must switch in a Pokémon, not move.`);
			}
			return { choiceType: choice };
		}

		if (choice.startsWith('move ')) {
			if (request.requestType !== 'move') {
				throw new Error(`You must switch in a Pokémon, not move.`);
			}
			const moveRequest = request.active[index]!;
			choice = choice.slice(5);
			let current: BattleMoveChoice = {
				choiceType: 'move',
				move: 0,
				targetLoc: 0,
				mega: false,
				megax: false,
				megay: false,
				ultra: false,
				z: false,
				max: false,
				tera: false,
				telepathy: false,
			};
			while (true) {
				// If data ends with a number, treat it as a target location.
				// We need to special case 'Conversion 2' so it doesn't get
				// confused with 'Conversion' erroneously sent with the target
				// '2' (since Conversion targets 'self', targetLoc can't be 2).
				if (/\s(?:-|\+)?[1-3]$/.test(choice) && toID(choice) !== 'conversion2') {
					if (current.targetLoc) throw new Error(`Move choice has multiple targets`);
					current.targetLoc = parseInt(choice.slice(-2), 10);
					choice = choice.slice(0, -2).trim();
				} else if (choice.endsWith(' mega')) {
					current.mega = true;
					choice = choice.slice(0, -5);
				} else if (choice.endsWith(' megax')) {
					current.megax = true;
					choice = choice.slice(0, -6);
				} else if (choice.endsWith(' megay')) {
					current.megay = true;
					choice = choice.slice(0, -6);
				} else if (choice.endsWith(' zmove')) {
					current.z = true;
					choice = choice.slice(0, -6);
				} else if (choice.endsWith(' ultra')) {
					current.ultra = true;
					choice = choice.slice(0, -6);
				} else if (choice.endsWith(' dynamax')) {
					current.max = true;
					choice = choice.slice(0, -8);
				} else if (choice.endsWith(' max')) {
					current.max = true;
					choice = choice.slice(0, -4);
				} else if (/ terastal(?:lize)? \S+$/i.test(choice)) {
					// §11 Tera Crystal: "<move> terastallize <type>" — capture the chosen type.
					const teraMatch = / (?:terastallize|terastal) (\S+)$/i.exec(choice)!;
					current.tera = true;
					current.teraType = teraMatch[1];
					choice = choice.slice(0, teraMatch.index);
				} else if (choice.endsWith(' terastallize')) {
					current.tera = true;
					choice = choice.slice(0, -13);
				} else if (choice.endsWith(' terastal')) {
					current.tera = true;
					choice = choice.slice(0, -9);
				} else if (choice.endsWith(' telepathy')) {
					current.telepathy = true;
					choice = choice.slice(0, -10);
				} else {
					break;
				}
			}

			if (/^[0-9]+$/.test(choice)) {
				// Parse a one-based move index.
				current.move = parseInt(choice, 10);
			} else {
				// Parse a move ID.
				// Move names are also allowed, but may cause ambiguity (see client issue #167).
				let moveid = toID(choice);
				if (moveid.startsWith('hiddenpower')) moveid = 'hiddenpower' as ID;

				for (let i = 0; i < moveRequest.moves.length; i++) {
					if (moveid === moveRequest.moves[i].id) {
						current.move = i + 1;
						if (moveRequest.moves[i].disabled) {
							throw new Error(`Move "${moveRequest.moves[i].name}" is disabled`);
						}
						break;
					}
				}
				if (!current.move && moveRequest.zMoves) {
					for (let i = 0; i < moveRequest.zMoves.length; i++) {
						if (!moveRequest.zMoves[i]) continue;
						if (moveid === moveRequest.zMoves[i]!.id) {
							current.move = i + 1;
							current.z = true;
							break;
						}
					}
				}
				if (!current.move && moveRequest.maxMoves) {
					for (let i = 0; i < moveRequest.maxMoves.length; i++) {
						if (moveid === moveRequest.maxMoves[i].id) {
							if (moveRequest.maxMoves[i].disabled) {
								throw new Error(`Move "${moveRequest.maxMoves[i].name}" is disabled`);
							}
							current.move = i + 1;
							current.max = true;
							break;
						}
					}
				}
			}
			if (current.max && !moveRequest.canDynamax) current.max = false;
			const move = this.currentMove(current, index);
			if (!move || move.disabled) {
				throw new Error(`Move ${move?.name ?? current.move} is disabled`);
			}
			return current;
		}

		if (choice.startsWith('switch ') || choice.startsWith('team ')) {
			choice = choice.slice(choice.startsWith('team ') ? 5 : 7);
			const isTeamPreview = request.requestType === 'team';
			let current: BattleSwitchChoice = {
				choiceType: isTeamPreview ? 'team' : 'switch',
				targetPokemon: 0,
			};
			if (choice === 'notMine') throw new Error(`You cannot decide for your partner!`);
			if (/^[0-9]+$/.test(choice)) {
				// Parse a one-based move index.
				current.targetPokemon = parseInt(choice, 10);
			} else {
				// Parse a pokemon name
				const lowerChoice = choice.toLowerCase();
				const choiceid = toID(choice);
				let matchLevel = 0;
				let match = 0;
				for (let i = 0; i < request.side.pokemon.length; i++) {
					const serverPokemon = request.side.pokemon[i];
					let curMatchLevel = 0;
					if (choice === serverPokemon.name) {
						curMatchLevel = 10;
					} else if (lowerChoice === serverPokemon.name.toLowerCase()) {
						curMatchLevel = 9;
					} else if (choiceid === toID(serverPokemon.name)) {
						curMatchLevel = 8;
					} else if (choiceid === toID(serverPokemon.speciesForme)) {
						curMatchLevel = 7;
					} else if (choiceid === toID(Dex.species.get(serverPokemon.speciesForme).baseSpecies)) {
						curMatchLevel = 6;
					}
					if (curMatchLevel > matchLevel) {
						match = i + 1;
						matchLevel = curMatchLevel;
					}
				}
				if (!match) {
					throw new Error(`Couldn't find Pokémon "${choice}" to switch to`);
				}
				current.targetPokemon = match;
			}
			if (!isTeamPreview && current.targetPokemon - 1 < this.requestLength()) {
				throw new Error(`That Pokémon is already in battle!`);
			}
			const target = request.side.pokemon[current.targetPokemon - 1];
			const isReviving = this.request.side?.pokemon!.some(p => p.reviving);
			if (!target) {
				throw new Error(`Couldn't find Pokémon "${choice}" to switch to!`);
			}
			if (isReviving && target.fainted) return current;
			if (isReviving && !target.fainted) {
				throw new Error(`${target.name} still has energy to battle!`);
			}
			if (target.fainted) {
				throw new Error(`${target.name} is fainted and cannot battle!`);
			}
			return current;
		}

		if (choice === 'pass') return null;

		throw new Error(`Unrecognized choice "${choice}"`);
	}

	/**
	 * Converts a choice from `BattleChoice` into string form
	 */
	stringChoice(choice: BattleChoice | null) {
		if (!choice) return `pass`;
		switch (choice.choiceType) {
		case 'move':
			const target = choice.targetLoc ? ` ${choice.targetLoc > 0 ? '+' : ''}${choice.targetLoc}` : ``;
			return `move ${choice.move}${this.moveSpecial(choice)}${target}`;
		case 'switch':
		case 'team':
			return `${choice.choiceType} ${choice.targetPokemon}`;
		case 'shift':
		case 'testfight':
			return choice.choiceType;
		}
	}
	moveSpecial(choice: BattleMoveChoice) {
		return (choice.max ? ' max' : '') +
			(choice.mega ? ' mega' : '') +
			(choice.megax ? ' megax' : '') +
			(choice.megay ? ' megay' : '') +
			(choice.ultra ? ' ultra' : '') +
			(choice.z ? ' zmove' : '') +
			// §11 Tera Crystal: emit the chosen type (lowercased ID) when one was picked.
			(choice.tera ? (choice.teraType ? ' terastallize ' + toID(choice.teraType) : ' terastallize') : '') +
			(choice.telepathy ? ' telepathy' : '');
	}

	/**
	 * The request sent from the server is actually really gross, but we'll have
	 * to wait until we transition to the new client before fixing it in the
	 * protocol, in the interests of not needing to fix it twice (or needing to
	 * fix it without TypeScript).
	 *
	 * In the meantime, this function converts a request from a shitty request
	 * to a request that makes sense.
	 *
	 * I'm sorry for literally all of this.
	 */
	static fixRequest(request: any, battle: Battle) {
		if (!request.requestType) {
			request.requestType = 'move';
			if (request.forceSwitch) {
				request.requestType = 'switch';
			} else if (request.teamPreview) {
				request.requestType = 'team';
			} else if (request.wait) {
				request.requestType = 'wait';
			}
		}

		if (request.requestType === 'wait') request.noCancel = true;
		if (request.side) {
			for (const serverPokemon of request.side.pokemon) {
				battle.parseDetails(serverPokemon.ident.substr(4), serverPokemon.ident, serverPokemon.details, serverPokemon);
				battle.parseHealth(serverPokemon.condition, serverPokemon);
			}
		}
		if (request.ally) {
			for (const serverPokemon of request.ally.pokemon) {
				battle.parseDetails(serverPokemon.ident.substr(4), serverPokemon.ident, serverPokemon.details, serverPokemon);
				battle.parseHealth(serverPokemon.condition, serverPokemon);
			}
		}
		if (request.requestType === 'team' && !request.chosenTeamSize) {
			request.chosenTeamSize = 1;
			if (battle.gameType === 'doubles') {
				request.chosenTeamSize = 2;
			}
			if (battle.gameType === 'triples' || battle.gameType === 'rotation') {
				request.chosenTeamSize = 3;
			}
			// Request full team order if one of our Pokémon has Illusion
			for (const switchable of request.side.pokemon) {
				if (toID(switchable.baseAbility) === 'illusion') {
					request.chosenTeamSize = request.side.pokemon.length;
				}
			}
			if (request.maxChosenTeamSize) {
				request.chosenTeamSize = request.maxChosenTeamSize;
			}
			if (battle.teamPreviewCount) {
				const chosenTeamSize = battle.teamPreviewCount;
				if (chosenTeamSize > 0 && chosenTeamSize <= request.side.pokemon.length) {
					request.chosenTeamSize = chosenTeamSize;
				}
			}
		}
		request.targetable ||= battle.mySide.active.length > 1;

		if (request.active) {
			request.active = request.active.map(
				(active: any, i: number) => request.side.pokemon[i].fainted ? null : active
			);
			for (const active of request.active) {
				if (!active) continue;
				for (const move of active.moves) {
					if (move.move) move.name = move.move;
					move.id = toID(move.name);
				}
				if (active.maxMoves) {
					if (active.maxMoves.maxMoves) {
						active.gigantamax = active.maxMoves.gigantamax;
						active.maxMoves = active.maxMoves.maxMoves;
					}
					for (const move of active.maxMoves) {
						if (move.move) move.name = Dex.moves.get(move.move).name;
						move.id = toID(move.name);
					}
				}
				if (active.canZMove) {
					active.zMoves = active.canZMove;
					for (const move of active.zMoves) {
						if (!move) continue;
						if (move.move) move.name = move.move;
						move.id = toID(move.name);
					}
				}
			}
		}
	}
}

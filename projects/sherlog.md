# Sherlog Holmes
*An LLM triage assistant for the 50,000-line logs that GPU firmware validation produces.*

The firmware validation team I work with produces a lot of logs. A single failing run on one GPU board can drop a 50,000-line text file into the artifact store, and on a bad day there are dozens of them. The signal is in there somewhere. Usually it is one line, sometimes a small cluster of lines, often buried under thousands of lines of perfectly normal driver chatter that just happen to have scary words like "error" or "timeout" in them. The work of triage is finding that one line and writing a sentence about it that a human firmware engineer can act on.

Sherlog Holmes is the system I built to do that work. The name was a joke that stuck. It runs as a small service inside the same platform that schedules the validation runs, picks up failed runs from a queue, and posts a triage summary back to the firmware team channel a few minutes after the failure lands.

## Why a flat LLM call did not work

The first version was the obvious one. Take the log, stuff it into a large-context model, ask "what failed and why." It was bad. The model would happily explain the contents of any random log line, regardless of whether that line had anything to do with the actual failure. Half the time the cited line was not even from the failing window. When the context did not fit, the truncation strategy dictated the answer, which is a polite way of saying the answer was arbitrary.

The fix was to stop pretending the LLM could do the whole job, and to give it less work to do.

## The five stages

The pipeline is five stages, and each one narrows what the next stage looks at.

The first stage is structural. Validation logs have a known shape: a header, the suite that ran, the boot sequence, the test cases in order, and a trailer. A small parser cuts the log into those sections so later stages can target the part that actually contains the failure rather than the boot noise above it.

The second stage is anchor finding. There are a few hundred known signature lines that the firmware team has accumulated over the years: kernel panic markers, specific error codes, a handful of regex patterns for the messages that mean "the test harness gave up." A scan over the failure window pulls anchors out of the noise and gives the next stage a much smaller window to chew on.

The third stage is retrieval. The validation suite has a backlog of past failures, each tagged with the root cause that the engineer eventually wrote down. I embed those failures with a small sentence-transformer model, store the vectors in FAISS, and at triage time embed the current failure window and pull the closest matches. About half the time the failure is a near-duplicate of something the team has already seen, and the retrieved example is more useful than anything an LLM can synthesize. The retriever returns five candidates with their original root causes attached.

The fourth stage is the LLM. By now the prompt is small: the failing section of the log, the anchors that were hit, the retrieved past failures with their root causes, and a tight instruction to either pick one of the retrieved causes if it fits, or to write a new one in the same style. The model is doing pattern matching over a short, well-formatted context. It is fast, it is cheap, and it is hard to get wrong.

The fifth stage is the writeup. The output goes through a small formatter that turns the model's answer into a Teams card with the cited log lines, the closest past failure, and a link back to the artifact in the platform. That is what the firmware engineer actually sees.

## The boring parts that mattered

The architecture is unsexy. A few Flask endpoints in front of Celery workers. Azure Service Bus as the queue so the platform team did not have to operate yet another broker. MongoDB for the failure store, because it was already there and the documents are awkwardly shaped. FAISS in-process per worker, with the index rebuilt nightly from the document store. The model calls go through a small gateway with caching, retry, and a circuit breaker, so a bad afternoon at the provider does not take the triage queue down.

The thing that made it useful in practice was idempotency. A given failure has a stable id derived from the run, so re-running triage on the same failure produces the same Teams card, in place. That meant the engineers on the firmware side could trust the card. If they wanted a fresh look they could ask, and the system would re-triage; otherwise the answer was stable, citable, and linked to its sources.

## What shipped

The firmware team uses it daily. The triage cards show up a few minutes after a failure, the anchors and citations are real, and the retrieved past failures usually do more work than the LLM does. The model is the smallest part of the system, which is the right shape for it.

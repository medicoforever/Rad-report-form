import { GoogleGenAI, Type, GenerateContentResponse, Chat } from "@google/genai";
import { GEMINI_PROMPT } from '../constants';

if (!process.env.API_KEY) {
    throw new Error("API_KEY environment variable not set");
}

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

export const blobToBase64 = (blob: Blob): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64data = reader.result as string;
      // remove the "data:audio/ogg;base64," part
      resolve(base64data.split(',')[1]);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
};

export const base64ToBlob = (base64: string, mimeType: string): Blob => {
  try {
    const byteCharacters = atob(base64);
    const byteNumbers = new Array(byteCharacters.length);
    for (let i = 0; i < byteCharacters.length; i++) {
      byteNumbers[i] = byteCharacters.charCodeAt(i);
    }
    const byteArray = new Uint8Array(byteNumbers);
    return new Blob([byteArray], { type: mimeType });
  } catch (e) {
    console.error("Failed to convert base64 to Blob:", e);
    // Return an empty blob on error
    return new Blob([], { type: mimeType });
  }
};


const getCleanMimeType = (blob: Blob): string => {
    let mimeType = blob.type;
    if (!mimeType) {
        // Fallback for files without a MIME type, maintaining original behavior.
        return 'audio/ogg';
    }
    // Handle WebM variations. It can be audio/webm or video/webm for audio-only files.
    // Also, strip codec information which might not be supported by the API.
    if (mimeType.startsWith('audio/webm') || mimeType.startsWith('video/webm')) {
        return 'audio/webm';
    }
    // For other types, just strip potential codec/parameter info
    return mimeType.split(';')[0];
};

const responseSchema = {
    type: Type.OBJECT,
    properties: {
        findings: {
            type: Type.ARRAY,
            items: {
                type: Type.STRING
            },
            description: "An array of strings, where each string is a corrected sentence or paragraph of the radiology findings."
        }
    }
};

export const processAudio = async (audioBlob: Blob, model: string): Promise<string[]> => {
  const base64Audio = await blobToBase64(audioBlob);

  const textPart = {
    text: GEMINI_PROMPT,
  };

  const audioPart = {
    inlineData: {
      mimeType: getCleanMimeType(audioBlob),
      data: base64Audio,
    },
  };
  
  try {
    const response: GenerateContentResponse = await ai.models.generateContent({
      model: model,
      contents: { parts: [textPart, audioPart] },
      config: {
          responseMimeType: "application/json",
          responseSchema: responseSchema
      }
    });

    const jsonString = response.text;
    if (!jsonString) {
      throw new Error("API returned an empty response.");
    }

    // Clean potential markdown code block fences
    const cleanedJsonString = jsonString.replace(/^```json\s*|```\s*$/g, '').trim();
    const result = JSON.parse(cleanedJsonString);

    if (result && Array.isArray(result.findings)) {
      return result.findings;
    } else {
      throw new Error("Invalid data structure in API response. Expected a 'findings' array.");
    }
  } catch (error) {
    console.error("Error calling Gemini API:", error);
    if (error instanceof Error) {
        throw new Error(`Failed to process audio: ${error.message}`);
    }
    throw new Error("An unknown error occurred while communicating with the API.");
  }
};

export const continueAudioDictation = async (existingText: string, audioBlob: Blob): Promise<string> => {
  const base64Audio = await blobToBase64(audioBlob);

  const prompt = `You are an expert medical transcriptionist specializing in radiology. A user is adding to their dictation.
The existing text is: "${existingText}".

Your task is to transcribe and correct ONLY the new audio provided. Your transcription should be a direct continuation of the existing text.

Follow these strict instructions to produce a clean and accurate continuation:
1. Analyze each word from the new audio for its contextual meaning within radiology and replace any incorrect words with the proper medical terminology. For example, a speech-to-text tool might misinterpret 'radiology findings' as something unrelated.
2. Completely ignore all non-verbal sounds (like coughing, sneezing) and any irrelevant side-conversations from the new audio. However, you MUST include any dictation related to the clinical profile or patient information.
3. If the new audio includes languages other than English, transcribe and translate the relevant medical findings into proper English.
4. Do not repeat any of the existing text in your output.
5. Your final output must be ONLY the newly corrected text, with no additional commentary, introductions, or explanations. Do not use any markdown formatting (like asterisks for bolding).`;

  const textPart = { text: prompt };
  const audioPart = {
    inlineData: {
      mimeType: getCleanMimeType(audioBlob),
      data: base64Audio,
    },
  };

  try {
    const response: GenerateContentResponse = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: { parts: [textPart, audioPart] },
    });

    const resultText = response.text?.trim();
    if (!resultText) {
      throw new Error("API returned an empty response for audio continuation.");
    }
    return resultText;
  } catch (error) {
    console.error("Error calling Gemini API for audio continuation:", error);
    if (error instanceof Error) {
        throw new Error(`Failed to process audio continuation: ${error.message}`);
    }
    throw new Error("An unknown error occurred while communicating with the API for audio continuation.");
  }
};

export const modifyFindingWithAudio = async (originalText: string, audioBlob: Blob): Promise<string> => {
  const base64Audio = await blobToBase64(audioBlob);

  const prompt = `You are an expert medical transcriptionist assistant. You will be given an existing medical finding text and an audio recording. The audio contains instructions and/or additional dictation to modify the original finding.

Your task is to return a single, updated string that intelligently incorporates the changes from the audio.
- If the audio provides additional details, integrate them coherently and grammatically into the existing text.
- If the audio provides an explicit instruction (e.g., "change 'normal' to 'unremarkable'", "remove the last sentence"), apply that instruction precisely.
- Correct any speech-to-text errors in the new dictation.
- Your final output must be ONLY the modified text, with no additional commentary, introductions, or explanations. Do not use any markdown formatting.

Existing Finding:
"${originalText}"

Now, listen to the audio and provide the single, updated finding text.`;

  const textPart = { text: prompt };
  const audioPart = {
    inlineData: {
      mimeType: getCleanMimeType(audioBlob),
      data: base64Audio,
    },
  };

  try {
    const response: GenerateContentResponse = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: { parts: [textPart, audioPart] },
    });

    const resultText = response.text?.trim();
    if (!resultText) {
      throw new Error("API returned an empty response for finding modification.");
    }
    return resultText;
  } catch (error) {
    console.error("Error calling Gemini API for finding modification:", error);
    if (error instanceof Error) {
        throw new Error(`Failed to process finding modification: ${error.message}`);
    }
    throw new Error("An unknown error occurred while communicating with the API for finding modification.");
  }
};


export const createChat = async (audioBlob: Blob, initialFindings: string[], model: string): Promise<Chat> => {
  const base64Audio = await blobToBase64(audioBlob);
  
  const userMessageParts = [
    {
      inlineData: {
        mimeType: getCleanMimeType(audioBlob),
        data: base64Audio,
      },
    },
    {
      text: `This is the audio I dictated.`,
    }
  ];

  const modelResponsePart = { text: `This is the transcript you requested:\n\n${initialFindings.join('\n\n')}` };

  const chat = ai.chats.create({
    model: model,
    config: {
      systemInstruction: 'You are a helpful AI assistant for a radiologist. The user has provided an audio dictation and you have transcribed it. Now, answer the user\'s follow-up questions based on the content of the audio and the transcript.',
    },
    history: [
      { role: 'user', parts: userMessageParts },
      { role: 'model', parts: [modelResponsePart] },
    ],
  });
  return chat;
};
# frozen_string_literal: true

require_relative "questions"

module Tigerquiz
  # Class lists: the students who may join a game, matched by name or id.
  module RosterDocument
    module_function

    # The roster a game uses, from a document or a plain array of names. Raises InvalidQuestion.
    def load(raw, id)
      raise InvalidQuestion, "bad roster id" unless id.to_s.match?(QuizDocument::ID)

      list = raw.is_a?(Array) ? raw : (raw.is_a?(Hash) ? raw["students"] : nil)
      raise InvalidQuestion, "roster has no students" unless list.is_a?(Array) && !list.empty?

      title = raw.is_a?(Hash) ? raw["title"] : nil
      {
        "id" => id.to_s,
        "title" => Questions.js_str(title.to_s.empty? ? id : title),
        "students" => list.map { |s| student(s) }
      }
    end

    def student(s)
      return { "name" => s, "id" => nil } if s.is_a?(String)

      s = s.is_a?(Hash) ? s : {}
      { "name" => Questions.js_str(s["name"]), "id" => s["id"].nil? ? nil : Questions.js_str(s["id"]) }
    end

    # What the editor sends, tidied: blank rows dropped, names and ids trimmed.
    def clean_students(list)
      Array(list)
        .map { |s| s.is_a?(String) ? { "name" => s } : s }
        .select { |s| s.is_a?(Hash) && !s["name"].to_s.strip.empty? }
        .map do |s|
          name = Questions.js_str(s["name"]).strip
          id = s["id"]
          id.nil? || id == "" || id == false ? { "name" => name } : { "name" => name, "id" => Questions.js_str(id).strip }
        end
    end

    # Match what a player typed against the roster. Returns the canonical entry or nil.
    def match(roster, typed)
      norm = Questions.norm_text(typed)
      return nil if norm.empty?

      students = roster["students"]
      students.find { |s| s["id"] && Questions.norm_text(s["id"]) == norm } ||
        students.find { |s| Questions.norm_text(s["name"]) == norm }
    end
  end
end

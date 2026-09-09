# One play-through of a quiz. Rows are written while the game runs, so a report
# survives a crash, and games that never finish are discarded.
class Game < ApplicationRecord
  self.primary_key = "id"

  belongs_to :user
  belongs_to :quiz, optional: true
  belongs_to :roster, optional: true
  has_many :game_questions, dependent: :delete_all
  has_many :game_players, dependent: :delete_all
  has_many :game_answers, dependent: :delete_all

  before_create { self.id ||= SecureRandom.uuid }

  scope :finished, -> { where.not(ended_at: nil) }
  scope :newest_first, -> { order(started_at: :desc) }

  def finished? = ended_at.present?

  # The row the reports list shows, with epoch milliseconds like the Node version.
  def listing
    {
      "id" => id, "pin" => pin, "quiz_id" => quiz_slug, "title" => title, "roster_id" => roster&.slug,
      "started_at" => ms(started_at), "ended_at" => ms(ended_at),
      "question_count" => question_count, "player_count" => player_count
    }
  end

  # ---------- written while a game runs ----------

  def upsert_player(name, identifier)
    game_players.find_or_initialize_by(name: name).update!(identifier: identifier)
  end

  def record_question(idx, q)
    game_questions.find_or_initialize_by(idx: idx).update!(
      question_type: q["type"], text: q["text"], answer: q["answerLabel"], choices: q["choices"],
      explanation: q["explanation"], source_idx: q["sourceIndex"], correct_answer: q["correctAnswer"]
    )
  end

  def record_answers(idx, rows)
    return if rows.empty?

    transaction do
      rows.each do |r|
        game_answers.find_or_initialize_by(idx: idx, player: r["player"])
                    .update!(response: r["response"], ms: r["ms"], correct: r["correct"], points: r["points"] || 0)
      end
    end
  end

  def finish!(board, question_count)
    transaction do
      board.each { |p| game_players.where(name: p["name"]).update_all(score: p["score"], rank: p["rank"]) }
      update!(ended_at: Time.current, question_count: question_count, player_count: board.length)
    end
  end

  # Abandon a game that never finished, so half-played rooms do not pile up.
  def discard_if_unfinished
    destroy unless finished?
  end

  # Drop recorded answers from this question onward, for replaying part of a game.
  def forget_from(idx)
    game_answers.where("idx >= ?", idx).delete_all
    game_questions.where("idx >= ?", idx).delete_all
  end

  private

  def ms(time) = time && (time.to_f * 1000).round
end

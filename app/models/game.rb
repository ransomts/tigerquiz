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
